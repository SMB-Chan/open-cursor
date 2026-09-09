import re
import os

with open("timetable.html", "r", encoding="utf-8") as f:
    content = f.read()

# We need to restructure the HTML to use tabs.

