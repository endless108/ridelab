#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RideLab – lokaler Webserver
===========================
Liefert die Website aus dem Ordner `web/` unter http://localhost:8188/ aus.
Die komplette Analyse (inkl. Pro-Analyse) läuft im Browser (web/engine.js),
deshalb funktioniert derselbe Ordner auch auf jedem statischen Hoster
(Netlify, GitHub Pages, Cloudflare Pages) – ganz ohne diesen Server.

Lokal ist der Server trotzdem praktisch: Die Fahrten speichert der Browser
pro Adresse, und unter http://localhost:8188/ liegen deine bisherigen Daten.

Start:   python ridelab_server.py
Nur Python-Standardbibliothek, keine Installation von Paketen nötig.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
PORT = 8188


class Server(ThreadingHTTPServer):
    # Unter Windows lässt SO_REUSEADDR mehrere Server auf demselben Port zu, dann
    # antwortet zufällig eine alte Instanz. Eine zweite Instanz soll stattdessen abbrechen.
    allow_reuse_address = os.name != "nt"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    try:
        server = Server(("127.0.0.1", port), Handler)
    except OSError:
        print(f"Port {port} ist belegt - RideLab laeuft vermutlich schon: http://localhost:{port}/")
        sys.exit(1)
    print(f"RideLab laeuft auf http://localhost:{port}/  (Beenden mit Strg+C)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
