"""Saves WiFi settings on the LED screen over USB, as an alternative to the setup hotspot.

Usage: python3 firmware/tools/set_wifi.py [port]
Asks for the WiFi name and password (the password isn't shown or stored anywhere else).
"""
import getpass
import glob
import os
import select
import sys
import termios
import time

port = sys.argv[1] if len(sys.argv) > 1 else (glob.glob("/dev/cu.usbmodem*") or [None])[0]
if not port:
    sys.exit("No LED screen found on USB. Plug the Mac into the board's USB port and try again.")

name = input("WiFi name: ").strip()
password = getpass.getpass("WiFi password (hidden): ")
if "|" in name:
    sys.exit("WiFi names with | aren't supported.")

fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
attrs = termios.tcgetattr(fd)
attrs[4] = attrs[5] = termios.B115200
attrs[3] &= ~(termios.ICANON | termios.ECHO)
attrs[1] &= ~termios.OPOST
termios.tcsetattr(fd, termios.TCSANOW, attrs)
os.write(fd, f"WIFI {name}|{password}\n".encode())

reply = b""
deadline = time.time() + 3
while b"OK WiFi saved" not in reply and time.time() < deadline:
    if select.select([fd], [], [], 0.2)[0]:
        try:
            reply += os.read(fd, 4096)
        except BlockingIOError:
            pass
os.close(fd)
if b"OK WiFi saved" in reply:
    print("Saved. The screen restarts and shows WIFI OK when it's connected (JOIN WIFI means it couldn't).")
else:
    sys.exit("The screen didn't answer. Is it running the player program?")
