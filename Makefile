SHELL := /bin/bash
PYTHON ?= python3

.PHONY: help discover discover-weekly normalize catalog-import catalog-status publish test release-check

help:
	@echo "SteamGuess current data workflow"
	@echo "  make discover         - refresh the current two-page candidate snapshot"
	@echo "  make discover-weekly  - fetch SteamSpy request=all pages 0..19"
	@echo "  make normalize        - rebuild the current snapshot from local raw pages"
	@echo "  make catalog-import   - upsert current JSON data into catalog.sqlite"
	@echo "  make catalog-status   - show catalog completeness and pending enrichment"
	@echo "  make publish          - publish the playable browser catalog"
	@echo "  make test             - run data pipeline tests"
	@echo "  make release-check    - run the complete release validation"
	@echo ""
	@echo "Old experimental commands are documented in scripts/README.md."

discover:
	npm run data:discover

discover-weekly:
	npm run data:discover-weekly

normalize:
	npm run data:normalize

catalog-import:
	npm run data:catalog-import

catalog-status:
	npm run data:catalog-status

publish:
	npm run data:publish-playable

test:
	npm run test:data

release-check:
	npm run release:check
