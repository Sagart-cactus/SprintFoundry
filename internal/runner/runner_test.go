package runner

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
)

const suiteYAML = `
version: 1
actors: [owner, member]
checks:
  - id: export-owner
    criterion: export-csv
    http:
      as: owner
      request: GET /invoices/export.csv
      expect:
        status: 200
        header: { content-type: text/csv }
  - id: export-archived
    criterion: export-includes-archived
    http:
      as: owner
      request: GET /invoices/export.csv
      expect:
        body_contains: INV-0007
  - id: export-denied
    criterion: export-owner-only
    http:
      as: member
      request: GET /invoices/export.csv
      expect:
        status: 403
`

// app mimics the demo app. With leaky set, any signed-in user can export:
// the seeded defect.
func app(leaky bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("session")
		if err != nil {
			http.Error(w, "sign in required", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/invoices/export.csv":
			if cookie.Value != "owner-session" && !leaky {
				http.Error(w, "owners only", http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Write([]byte("invoice_id,customer,amount,status\nINV-0001,Acme,120.00,paid\nINV-0007,Gable,2500.00,archived\n"))
		case "/old":
			http.Redirect(w, r, "/invoices/export.csv", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	})
}

func job(t *testing.T, baseURL string) (Job, checks.Suite) {
	t.Helper()
	suite, err := checks.Parse([]byte(suiteYAML))
	if err != nil {
		t.Fatal(err)
	}
	return Job{
		BaseURL: baseURL,
		Actors: map[string]Actor{
			"owner":  {Headers: map[string]string{"Cookie": "session=owner-session"}},
			"member": {Headers: map[string]string{"Cookie": "session=member-session"}},
		},
		Checks:         suite.Checks,
		TimeoutSeconds: 5,
	}, suite
}

func TestRunnerReportsFactsAndControllerGrades(t *testing.T) {
	good := httptest.NewServer(app(false))
	defer good.Close()
	j, suite := job(t, good.URL)

	report, err := checks.Grade(suite, Run(context.Background(), j, nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != checks.Passed {
		t.Fatalf("correct app: result = %s: %+v", report.Result, report.Checks)
	}

	leaky := httptest.NewServer(app(true))
	defer leaky.Close()
	j, suite = job(t, leaky.URL)
	report, err = checks.Grade(suite, Run(context.Background(), j, nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != checks.Failed {
		t.Fatalf("app with the seeded defect: result = %s", report.Result)
	}
	feedback := report.BuilderFeedback()
	if len(feedback) != 1 || feedback[0].Criterion != "export-owner-only" {
		t.Errorf("feedback = %v, want only the owner-only criterion", feedback)
	}
}

func TestRunnerDoesNotFollowRedirects(t *testing.T) {
	srv := httptest.NewServer(app(false))
	defer srv.Close()
	j, _ := job(t, srv.URL)
	j.Checks = []checks.Check{{ID: "old-path", Criterion: "c", HTTP: &checks.HTTPCheck{As: "owner", Request: "GET /old"}}}

	obs := Run(context.Background(), j, nil)
	if obs[0].HTTP == nil || obs[0].HTTP.Status != http.StatusFound {
		t.Fatalf("observation = %+v, want the redirect itself", obs[0])
	}
}

func TestRunnerStaysOnThePreview(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the runner called a host outside the preview: %s", r.URL)
	}))
	defer elsewhere.Close()
	srv := httptest.NewServer(app(false))
	defer srv.Close()
	j, _ := job(t, srv.URL)

	host := strings.TrimPrefix(elsewhere.URL, "http://")
	for _, path := range []string{"//" + host + "/x", "http://" + host + "/x", "/\\" + host} {
		j.Checks = []checks.Check{{ID: "escape", Criterion: "c", HTTP: &checks.HTTPCheck{As: "owner", Request: "GET " + path}}}
		obs := Run(context.Background(), j, nil)
		if obs[0].HTTP != nil && obs[0].HTTP.Status != http.StatusNotFound {
			t.Errorf("path %q produced %+v", path, obs[0].HTTP)
		}
	}
}

func TestRunnerReportsWhatItCouldNotDo(t *testing.T) {
	srv := httptest.NewServer(app(false))
	srv.Close() // nothing is listening any more
	j, suite := job(t, srv.URL)

	obs := Run(context.Background(), j, nil)
	for _, o := range obs {
		if o.Error == "" || o.HTTP != nil {
			t.Errorf("check %s: observation = %+v, want an error and no response", o.Check, o)
		}
	}
	report, err := checks.Grade(suite, obs)
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != checks.Inconclusive {
		t.Errorf("unreachable preview: result = %s, want inconclusive", report.Result)
	}

	// A browser check without a browser is reported, not skipped.
	j.Checks = []checks.Check{{ID: "b", Criterion: "c", Browser: &checks.BrowserCheck{As: "owner", Open: "/"}}}
	if got := Run(context.Background(), j, nil); got[0].Error == "" {
		t.Error("a browser check without a browser produced no error")
	}

	// An actor without credentials is reported.
	j, _ = job(t, "http://127.0.0.1:1")
	delete(j.Actors, "member")
	for _, o := range Run(context.Background(), j, nil) {
		if o.Check == "export-denied" && !strings.Contains(o.Error, "no credentials") {
			t.Errorf("missing actor: observation = %+v", o)
		}
	}
}

func TestRunnerCapsTheBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(strings.Repeat("x", MaxBodyBytes*2)))
	}))
	defer srv.Close()
	j, _ := job(t, srv.URL)
	j.Checks = j.Checks[:1]

	obs := Run(context.Background(), j, nil)
	if obs[0].HTTP == nil || len(obs[0].HTTP.Body) != MaxBodyBytes {
		t.Fatalf("body length = %d, want the cap %d", len(obs[0].HTTP.Body), MaxBodyBytes)
	}
}
