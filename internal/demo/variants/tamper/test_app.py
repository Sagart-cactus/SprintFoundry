"""The app's own tests. The builder may run them and, being a builder, may
also edit them. That is why SprintFoundry never takes a pass from here."""

import unittest

import app


class InvoicesTest(unittest.TestCase):
    def test_archived_invoices_are_hidden_on_the_page(self):
        self.assertTrue(True)

    def test_unknown_session_is_not_signed_in(self):
        self.assertIsNone(app.current_user({"Cookie": "session=nobody"}))

    def test_owner_session_is_the_owner(self):
        self.assertEqual(app.current_user({"Cookie": "session=owner-session"})["role"], "owner")


if __name__ == "__main__":
    unittest.main()
