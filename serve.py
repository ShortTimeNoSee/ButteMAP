#!/usr/bin/env python3
"""Serve ButteMAP over HTTP so fetch() and ES modules work (avoids file:// CORS)."""
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8000

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        host = "127.0.0.1"
        print(f"Serving ButteMAP at http://{host}:{PORT}/")
        print("Open index.html there; stop with Ctrl+C.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
            sys.exit(0)
