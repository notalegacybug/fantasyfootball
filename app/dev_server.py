"""
Local preview of the web app: serves app/www like Cloudflare Pages does, including the
_redirects rule (/league/* -> index.html). Standard library only.

    python app/dev_server.py          # http://localhost:8788
"""

import http.server
import pathlib

WWW = pathlib.Path(__file__).parent / "www"
PORT = 8788


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WWW), **kw)

    def do_GET(self):
        if self.path.startswith("/league/"):
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")     # always serve the file just edited
        super().end_headers()


http.server.SimpleHTTPRequestHandler.extensions_map[".js"] = "text/javascript"
if __name__ == "__main__":
    print(f"Fantasy Weekly preview on http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
