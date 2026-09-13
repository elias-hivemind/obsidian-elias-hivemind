.PHONY: dev build package clean health

dev:
	npm run dev

build:
	npm run build

package:
	npm run package

health:
	npm run health

clean:
	rm -rf dist build node_modules
