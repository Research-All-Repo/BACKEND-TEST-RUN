"""Simulated tilapia ponds, used to give the model a head start before there is enough real data.

Each pond follows a standard dissolved-oxygen balance, minute by minute:

    dDO/dt = photosynthesis(light, temperature) - respiration(temperature, feeding)
             + surface re-aeration(wind) * (saturation - DO) + aerator * (saturation - DO)

with weather that changes from day to day (sunny / cloudy / rainy days, passing clouds, wind),
algae blooms and die-offs, fish feeding, occasional night-time turnover events (sudden DO drops),
some ponds with an aerator the operator switches on at night, and a realistic sensor on top
(noise, small offset and drift, spikes, missing readings and short outages).

Every pond gets different settings (depth, algae, fish load, wind ...), so the model learns the
general SHAPE of DO changes rather than one pond. It is still a simulation: once the real pond has
a couple of weeks of readings, `aquacast-edge train` adapts the model to it.

Needs numpy (training only; the Pi does not use this file to forecast).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

from .features import LOCAL_UTC_OFFSET_H, STEP_MIN, do_saturation

DT_MIN = 2  # simulation step (minutes)


def simulate(n_ponds=60, days=30, seed=1, burn_in_days=2, start=None):
    """-> list of dicts {"times": [datetime UTC ...], "do": np.array (NaN = missing), "temp": np.array}
    one per pond, sampled every 10 minutes like the Raspberry Pi."""
    rng = np.random.default_rng(seed)
    P = n_ponds
    total_days = days + burn_in_days
    slots_per_day = 24 * 60 // STEP_MIN
    n_slots = total_days * slots_per_day
    sub = STEP_MIN // DT_MIN
    dt_h = DT_MIN / 60

    # ---- pond settings ----
    depth = rng.uniform(0.8, 1.8, P)
    pmax0 = np.exp(rng.normal(np.log(1.1), 0.35, P))            # mg/L/h at full sun, 28 C
    ik = rng.uniform(0.12, 0.40, P)                             # light half-saturation (share of full sun)
    resp_ratio = rng.uniform(1.05, 1.60, P)                     # day respiration vs day production
    fish_share = rng.uniform(0.25, 0.6, P)                      # share of respiration from fish/sediment (steady)
    wind_mean = rng.uniform(0.6, 3.0, P)                        # m/s
    temp_mean = rng.uniform(26.0, 31.0, P)
    temp_amp = rng.uniform(0.8, 2.4, P)
    has_aerator = rng.random(P) < 0.5
    aer_k = rng.uniform(0.35, 1.1, P)                           # 1/h
    aer_on_below = rng.uniform(3.3, 4.6, P)
    feed_boost = rng.uniform(1.05, 1.45, P)
    feed_times = np.stack([rng.uniform(7.0, 9.0, P), rng.uniform(15.0, 17.0, P)], 1)
    noise_sd = rng.uniform(0.02, 0.10, P)
    offset = rng.uniform(-0.3, 0.3, P)
    drift_per_day = rng.uniform(-0.03, 0.03, P)
    missing_p = rng.uniform(0.0, 0.03, P)

    # ---- day-to-day weather and algae ----
    cloud = np.clip(rng.beta(1.3, 1.6, (total_days, P)), 0, 1)
    rain = rng.random((total_days, P)) < 0.15
    cloud[rain] = np.maximum(cloud[rain], rng.uniform(0.8, 1.0, rain.sum()))
    algae = np.zeros((total_days, P))
    for d in range(1, total_days):
        algae[d] = 0.85 * algae[d - 1] + rng.normal(0, 0.16, P)
    algae_mult = np.exp(algae)
    wind_day = np.exp(rng.normal(0, 0.35, (total_days, P)))
    temp_day = np.cumsum(rng.normal(0, 0.35, (total_days, P)), 0) * 0.5 - 1.2 * rain
    turnover = (rng.random((total_days, P)) < 0.05) & (wind_day < 1.0)
    turnover_hour = rng.uniform(20.0, 27.0, (total_days, P))     # 20:00 .. 03:00 local
    turnover_size = rng.uniform(1.0, 3.0, (total_days, P))       # mg/L/h at its peak

    # ---- within-day variation (one value per 10 minutes) ----
    def ar1(phi, sd, shape):
        x = np.zeros(shape)
        e = rng.normal(0, sd, shape)
        for i in range(1, shape[0]):
            x[i] = phi * x[i - 1] + e[i]
        return x
    cloud_flicker = ar1(0.85, 0.18, (n_slots, P))
    gust = ar1(0.8, 0.25, (n_slots, P))

    start = start or datetime(2025, 1, 1, tzinfo=timezone.utc) - timedelta(hours=LOCAL_UTC_OFFSET_H)  # local midnight
    sat = lambda t: do_saturation(t)  # noqa: E731

    do_true = sat(temp_mean) * rng.uniform(0.6, 1.0, P)
    aer_on = np.zeros(P, bool)
    out_do = np.empty((n_slots, P))
    out_t = np.empty((n_slots, P))

    for s in range(n_slots):
        d = s // slots_per_day
        h_slot = (s % slots_per_day) * STEP_MIN / 60
        cday = cloud[d]
        c_eff = np.clip(cday + cloud_flicker[s] * 4 * cday * (1 - cday), 0, 1)
        wind = np.maximum(0.0, wind_mean * wind_day[d] * (1 + 0.5 * np.sin(2 * np.pi * (h_slot - 14) / 24)) + gust[s])
        k_air = (0.03 + 0.01 * wind ** 2) / depth                # 1/h
        for j in range(sub):
            h = h_slot + j * DT_MIN / 60
            sun = max(0.0, np.sin(np.pi * (h - 6) / 12)) ** 1.2 if 6 < h < 18 else 0.0
            light = sun * (1 - 0.75 * c_eff ** 1.5)
            temp = temp_mean + temp_day[d] + temp_amp * (1 - 0.5 * cday) * np.sin(2 * np.pi * (h - 9.5) / 24)
            tf_p = 1.036 ** (temp - 28)
            prod = pmax0 * algae_mult[d] * (light / (light + ik)) * (1 + ik) * tf_p
            # respiration balanced against a typical day's production, part steady (fish), part algae
            daily_p = pmax0 * 6.7 / 24
            resp = daily_p * resp_ratio * (fish_share + (1 - fish_share) * algae_mult[d]) * 1.047 ** (temp - 28)
            for f in range(2):
                dtf = h - feed_times[:, f]
                resp = resp * np.where((dtf >= 0) & (dtf < 2.5), 1 + (feed_boost - 1) * np.exp(-dtf / 1.0), 1.0)
            hh = h if h >= 12 else h + 24
            resp = resp + turnover[d] * turnover_size[d] * np.exp(-((hh - turnover_hour[d]) ** 2) / (2 * 0.6 ** 2))
            night = (h >= 18) | (h < 6.5)
            aer_on = has_aerator & np.where(aer_on, night & (do_true < aer_on_below + 1.6), night & (do_true < aer_on_below))
            dsat = sat(temp) - do_true
            ddo = prod - resp + k_air * dsat + aer_on * aer_k * dsat
            do_true = np.clip(do_true + ddo * dt_h, 0.05, 20.0)
        out_do[s] = do_true
        out_t[s] = temp

    # ---- the sensor ----
    days_f = np.arange(n_slots)[:, None] / slots_per_day
    meas = out_do + offset + drift_per_day * days_f + rng.normal(0, 1, (n_slots, P)) * noise_sd
    spikes = rng.random((n_slots, P)) < 0.002
    meas[spikes] += rng.choice([-1, 1], spikes.sum()) * rng.uniform(1.0, 3.0, spikes.sum())
    meas = np.clip(meas, 0.0, 20.0)
    meas[rng.random((n_slots, P)) < missing_p] = np.nan
    temp_meas = out_t + rng.normal(0, 0.05, (n_slots, P))
    for p in range(P):  # outages of 1-6 hours on ~5% of days
        for d in np.nonzero(rng.random(total_days) < 0.05)[0]:
            a = d * slots_per_day + rng.integers(0, slots_per_day)
            b = a + rng.integers(6, 37)
            meas[a:b, p] = np.nan
            temp_meas[a:b, p] = np.nan

    skip = burn_in_days * slots_per_day
    times = [start + timedelta(minutes=STEP_MIN * i) for i in range(skip, n_slots)]
    return [{"times": times, "do": np.round(meas[skip:, p], 2), "temp": np.round(temp_meas[skip:, p], 2),
             "true_do": out_do[skip:, p]} for p in range(P)]
