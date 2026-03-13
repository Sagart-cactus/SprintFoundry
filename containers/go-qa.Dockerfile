ARG BASE_IMAGE=sprintfoundry/agent-base:latest
FROM ${BASE_IMAGE}

USER root

# Go 1.23
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV GOLANG_VERSION=1.23.4 \
    GOPATH=/home/agent/go \
    PATH=/usr/local/go/bin:/home/agent/go/bin:${PATH}

RUN wget -q "https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    && tar -C /usr/local -xzf "go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    && rm "go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    && mkdir -p "${GOPATH}" \
    && chown -R agent:agent "${GOPATH}"

# Go test and coverage tools
USER agent

RUN go install gotest.tools/gotestsum@latest \
    && go install github.com/axw/gocov/gocov@latest \
    && go install github.com/AlekSi/gocov-xml@latest \
    && go install golang.org/x/tools/cmd/goimports@latest

WORKDIR /workspace
