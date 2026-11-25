"""Remove a streamer from the saved accounts (and never save them again).

    python links_admin.py remove <twitch login>

Run on the VPS by the 'Remove a streamer' workflow when a streamer asks.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from store import Store  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] != "remove":
        print(__doc__)
        return 2
    login = argv[2].strip().lower().removeprefix("https://www.twitch.tv/").removeprefix("twitch.tv/").strip("/")
    if not (3 <= len(login) <= 25 and login.replace("_", "").isalnum()):
        print(f"'{login}' isn't a Twitch channel name")
        return 2
    store = Store(os.environ.get("CROSSPOV_DB", os.path.join(HERE, "readings.db")))
    removed = store.opt_out(login)
    print(f"{login}: removed {removed} saved account(s); it will not be saved again.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
