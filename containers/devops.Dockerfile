# SprintFoundry — DevOps Agent
# CI/CD and infrastructure tooling.

ARG BASE_IMAGE=sprintfoundry/agent-base:latest
FROM ${BASE_IMAGE}

USER root

# Install infrastructure tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    apt-transport-https \
    docker.io \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install OpenTofu from the official Debian repository.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://get.opentofu.org/opentofu.gpg \
    | tee /etc/apt/keyrings/opentofu.gpg > /dev/null \
    && curl -fsSL https://packages.opentofu.org/opentofu/tofu/gpgkey \
    | gpg --no-tty --batch --dearmor -o /etc/apt/keyrings/opentofu-repo.gpg \
    && chmod a+r /etc/apt/keyrings/opentofu.gpg /etc/apt/keyrings/opentofu-repo.gpg \
    && printf '%s\n%s\n' \
    'deb [signed-by=/etc/apt/keyrings/opentofu.gpg,/etc/apt/keyrings/opentofu-repo.gpg] https://packages.opentofu.org/opentofu/tofu/any/ any main' \
    'deb-src [signed-by=/etc/apt/keyrings/opentofu.gpg,/etc/apt/keyrings/opentofu-repo.gpg] https://packages.opentofu.org/opentofu/tofu/any/ any main' \
    > /etc/apt/sources.list.d/opentofu.list \
    && chmod a+r /etc/apt/sources.list.d/opentofu.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends tofu \
    && ln -sf /usr/bin/tofu /usr/local/bin/terraform \
    && rm -rf /var/lib/apt/lists/*

# Install actionlint for GitHub Actions validation
RUN curl -fsSL https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz \
    | tar xz -C /usr/local/bin actionlint

USER agent
WORKDIR /workspace
