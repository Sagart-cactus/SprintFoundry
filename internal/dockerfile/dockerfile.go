// Package dockerfile checks a builder-written Dockerfile before the
// controller builds it.
//
// A build runs with no network for its RUN steps, but that is not the whole
// story: a FROM line makes the runtime contact a registry, a syntax directive
// makes it download and run a different build front end, and ADD can fetch a
// URL, all outside the build's own network setting. The check therefore
// allows only base images the run spec lists, and refuses the instructions
// that reach outside the build context.
package dockerfile

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ErrRefused is returned for a Dockerfile the controller will not build.
var ErrRefused = errors.New("dockerfile: refused")

var (
	directive = regexp.MustCompile(`^#\s*([A-Za-z]+)\s*=`)
	stageName = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]*$`)
)

// Check refuses a Dockerfile that uses a base image outside allowedBases or
// an instruction that reaches outside the build context. Base images are
// compared as exact strings, so the run spec should list them by digest.
func Check(content []byte, allowedBases []string) error {
	refuse := func(line int, format string, args ...any) error {
		return fmt.Errorf("%w: line %d: %s", ErrRefused, line, fmt.Sprintf(format, args...))
	}
	allowed := map[string]bool{"scratch": true}
	for _, base := range allowedBases {
		allowed[base] = true
	}

	lines := strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n")
	stages := map[string]bool{}
	stageCount := 0
	sawInstruction := false

	for i := 0; i < len(lines); i++ {
		start := i + 1
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			// Parser directives are only honoured before the first
			// instruction. None of them is needed, and two of them change how
			// the rest of the file is read or which program reads it.
			if m := directive.FindStringSubmatch(line); m != nil && !sawInstruction {
				return refuse(start, "parser directive %q is not allowed", strings.ToLower(m[1]))
			}
			continue
		}
		// Join continuation lines. Comment lines inside a continued
		// instruction are dropped, as the builder does.
		for strings.HasSuffix(line, "\\") && i+1 < len(lines) {
			i++
			next := strings.TrimSpace(lines[i])
			if strings.HasPrefix(next, "#") {
				continue
			}
			line = strings.TrimSpace(strings.TrimSuffix(line, "\\")) + " " + next
		}
		sawInstruction = true
		fields := strings.Fields(line)
		keyword := strings.ToUpper(fields[0])
		args := fields[1:]
		if keyword == "ONBUILD" && len(args) > 0 {
			keyword, args = strings.ToUpper(args[0]), args[1:]
		}
		flags, rest := splitFlags(args)

		switch keyword {
		case "FROM":
			for _, f := range flags {
				if strings.Contains(f, "$") {
					return refuse(start, "FROM flag %q uses a variable", f)
				}
			}
			if len(rest) == 0 {
				return refuse(start, "FROM names no image")
			}
			image := rest[0]
			if strings.Contains(image, "$") {
				return refuse(start, "FROM %q uses a variable, so the base image cannot be checked", image)
			}
			if !allowed[image] && !stages[strings.ToLower(image)] {
				return refuse(start, "base image %q is not in the run spec's list", image)
			}
			if len(rest) >= 3 && strings.EqualFold(rest[1], "AS") {
				name := strings.ToLower(rest[2])
				if !stageName.MatchString(name) {
					return refuse(start, "stage name %q is not valid", rest[2])
				}
				stages[name] = true
			}
			stageCount++
		case "COPY", "ADD":
			for _, f := range flags {
				if from, ok := strings.CutPrefix(f, "--from="); ok && !isEarlierStage(from, stages, stageCount) {
					return refuse(start, "%s --from=%s takes files from outside this build", keyword, from)
				}
			}
			if keyword == "ADD" {
				for _, src := range rest {
					lower := strings.ToLower(src)
					if strings.Contains(lower, "://") || strings.HasPrefix(lower, "git@") {
						return refuse(start, "ADD fetches %q from the network", src)
					}
				}
			}
		case "RUN":
			for _, f := range flags {
				switch {
				case strings.HasPrefix(f, "--network="):
					if v := strings.TrimPrefix(f, "--network="); v != "none" && v != "default" {
						return refuse(start, "RUN --network=%s is not allowed", v)
					}
				case strings.HasPrefix(f, "--security="):
					return refuse(start, "RUN %s is not allowed", f)
				case strings.HasPrefix(f, "--mount="):
					if err := checkMount(strings.TrimPrefix(f, "--mount="), stages, stageCount); err != nil {
						return refuse(start, "RUN --mount: %v", err)
					}
				}
			}
		}
	}
	if stageCount == 0 {
		return fmt.Errorf("%w: the file has no FROM instruction", ErrRefused)
	}
	return nil
}

// splitFlags separates the leading --flags of an instruction from the rest.
func splitFlags(args []string) (flags, rest []string) {
	for i, a := range args {
		if !strings.HasPrefix(a, "--") {
			return args[:i], args[i:]
		}
	}
	return args, nil
}

func isEarlierStage(ref string, stages map[string]bool, stageCount int) bool {
	if stages[strings.ToLower(ref)] {
		return true
	}
	if n, err := strconv.Atoi(ref); err == nil {
		return n >= 0 && n < stageCount-1
	}
	return false
}

func checkMount(spec string, stages map[string]bool, stageCount int) error {
	kind := "bind"
	from := ""
	for _, part := range strings.Split(spec, ",") {
		key, value, _ := strings.Cut(part, "=")
		switch strings.ToLower(key) {
		case "type":
			kind = strings.ToLower(value)
		case "from":
			from = value
		}
	}
	if kind != "bind" && kind != "cache" && kind != "tmpfs" {
		return fmt.Errorf("mount type %q is not allowed", kind)
	}
	if from != "" && !isEarlierStage(from, stages, stageCount+1) {
		return fmt.Errorf("mount from %q takes files from outside this build", from)
	}
	return nil
}
