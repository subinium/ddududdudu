.PHONY: build dev typecheck lint format test bench clean install ci

build:
	npm run build

dev:
	npm run dev

typecheck:
	npm run typecheck

lint:
	npx biome check src/

format:
	npx biome format --write src/

test:
	npm test

bench:
	npm run bench:run

clean:
	npm run clean

install:
	npm run install:global

ci: typecheck lint test
