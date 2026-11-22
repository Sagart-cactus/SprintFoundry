# SprintFoundry v1

RUNNER_BIN := internal/runnerimage/bin
VERSION    ?= v1-dev

.PHONY: all runner build test clean

all: build

# The check runner runs inside a Linux container, whatever the host is. Its
# binaries are embedded into the main binary, so they are built first.
runner:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o $(RUNNER_BIN)/runner-linux-amd64 ./cmd/sprintfoundry-runner
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o $(RUNNER_BIN)/runner-linux-arm64 ./cmd/sprintfoundry-runner

build: runner
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o sprintfoundry ./cmd/sprintfoundry

test: runner
	go test -race -count=1 ./...

clean:
	rm -f sprintfoundry $(RUNNER_BIN)/runner-linux-*
