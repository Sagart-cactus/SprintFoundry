"""Invoices: the small web app the SprintFoundry demo builds a feature into.

Standard library only, so the image builds with no network.
"""

import html
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Fixture sessions. The demo's run spec gives each actor one of these cookies.
SESSIONS = {
    "owner-session": {"name": "Olivia", "role": "owner"},
    "member-session": {"name": "Milan", "role": "member"},
}

INVOICES = [
    {"id": "INV-0001", "customer": "Acme Tools", "amount": "120.00", "status": "paid", "archived": False},
    {"id": "INV-0002", "customer": "Birch Cafe", "amount": "48.50", "status": "open", "archived": False},
    {"id": "INV-0003", "customer": "Cobalt Labs", "amount": "990.00", "status": "open", "archived": False},
    {"id": "INV-0004", "customer": "Delta Print", "amount": "15.25", "status": "paid", "archived": False},
    {"id": "INV-0005", "customer": "Elm Street Gym", "amount": "300.00", "status": "overdue", "archived": False},
    {"id": "INV-0006", "customer": "Fjord Travel", "amount": "72.10", "status": "paid", "archived": False},
    {"id": "INV-0007", "customer": "Gable Roofing", "amount": "2500.00", "status": "paid", "archived": True},
]


def current_user(headers):
    """Return the signed-in user for a request, or None."""
    cookie = SimpleCookie(headers.get("Cookie", ""))
    session = cookie.get("session")
    return SESSIONS.get(session.value) if session else None


def visible_invoices():
    """Invoices shown on the page. Archived invoices are hidden there."""
    return [invoice for invoice in INVOICES if not invoice["archived"]]


def export_csv():
    """Every invoice, archived ones included, as CSV text."""
    lines = ["invoice_id,customer,amount,status"]
    for invoice in INVOICES:
        status = "archived" if invoice["archived"] else invoice["status"]
        lines.append("{},{},{},{}".format(invoice["id"], invoice["customer"], invoice["amount"], status))
    return "\n".join(lines) + "\n"


def invoices_page(user):
    rows = "".join(
        "<tr><td>{id}</td><td>{customer}</td><td>{amount}</td><td>{status}</td></tr>".format(
            **{key: html.escape(str(value)) for key, value in invoice.items()}
        )
        for invoice in visible_invoices()
    )
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Invoices</title></head>"
        "<body><header><p>Signed in as {name} ({role})</p></header>"
        "<main><h1>Invoices</h1>{export}"
        "<table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead>"
        "<tbody>{rows}</tbody></table></main></body></html>"
    ).format(
        name=html.escape(user["name"]),
        role=html.escape(user["role"]),
        rows=rows,
        export="<p><a role='button' href='/invoices/export.csv'>Export CSV</a></p>" if user["role"] == "owner" else "",
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "Invoices/1.0"

    def do_GET(self):
        if self.path == "/healthz":
            return self.respond(200, "text/plain; charset=utf-8", "ok\n")
        user = current_user(self.headers)
        if user is None:
            return self.respond(401, "text/plain; charset=utf-8", "sign in required\n")
        if self.path in ("/", "/invoices"):
            return self.respond(200, "text/html; charset=utf-8", invoices_page(user))
        if self.path == "/invoices/export.csv":
            if user["role"] != "owner":
                return self.respond(403, "text/plain; charset=utf-8", "only the account owner can export invoices\n")
            return self.respond(200, "text/csv; charset=utf-8", export_csv())
        return self.respond(404, "text/plain; charset=utf-8", "not found\n")

    def respond(self, status, content_type, body):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # keep the preview quiet


def main():
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    main()
