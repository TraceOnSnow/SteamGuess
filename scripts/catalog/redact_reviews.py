#!/usr/bin/env python3
"""Create safe review-hint text from an existing catalog without network calls.

Raw review text is preserved in ``text``.  The generated ``redactedText`` is
what the playable publisher uses for the in-game review hint.
"""

from scripts.catalog.review_redaction import main


if __name__ == "__main__":
    main()
