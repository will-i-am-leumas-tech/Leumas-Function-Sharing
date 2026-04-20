from http.server import BaseHTTPRequestHandler, HTTPServer

from processors import parse_sales_csv, summarize_sales


SAMPLE = "region,revenue,units\nnorth,1200.5,4\nsouth,700,2\nnorth,300,1\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/summary":
            self.send_response(404)
            self.end_headers()
            return

        summary = summarize_sales(parse_sales_csv(SAMPLE))
        payload = str(summary).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def serve(port: int = 8000) -> None:
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    serve()
