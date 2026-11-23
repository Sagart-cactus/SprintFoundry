# SprintFoundry v1

RUNNER_BIN := internal/runnerimage/bin
VERSION    ?= v1-dev

.PHONY: all runner build test clean

all: build

# The check runner runs inside a Linux container, whatever the host is. Its
# binaries are embedded into the main binary, so they are built first.
runner:
	for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "-s -w" -o $(RUNNER_BIN)/runner-linux-$$arch ./cmd/sprintfoundry-runner && \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "-s -w" -o $(RUNNER_BIN)/proxy-linux-$$arch ./cmd/sprintfoundry-proxy || exit 1; \
	done

build: runner
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o sprintfoundry ./cmd/sprintfoundry

test: runner
	go test -race -count=1 ./...

clean:
	rm -f sprintfoundry $(RUNNER_BIN)/runner-linux-* $(RUNNER_BIN)/proxy-linux-*
