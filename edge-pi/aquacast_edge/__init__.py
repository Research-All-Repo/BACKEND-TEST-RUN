"""AquaCast edge program for the Raspberry Pi.

Reads the pond sensors every 10 minutes, computes the DO forecasts and the risk level,
keeps everything on the SD card first (SQLite outbox) and uploads it to the AquaCast
dashboard when the internet is available. Also switches the aerator relay for the
dashboard's ON/OFF requests and for AUTOMATIC mode.
"""
VERSION = "1.1.0"
