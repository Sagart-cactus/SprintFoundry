{{/*
Expand the name of the chart.
*/}}
{{- define "sprintfoundry.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "sprintfoundry.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label value.
*/}}
{{- define "sprintfoundry.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "sprintfoundry.labels" -}}
helm.sh/chart: {{ include "sprintfoundry.chart" . }}
{{ include "sprintfoundry.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "sprintfoundry.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sprintfoundry.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "sprintfoundry.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (printf "%s-dispatch-controller" (include "sprintfoundry.fullname" .)) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
System secret name.
*/}}
{{- define "sprintfoundry.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- printf "%s-system-secrets" (include "sprintfoundry.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Resolve shared auth tokens once per render so generated values stay consistent
across system and project namespace resources.
*/}}
{{- define "sprintfoundry.resolvedSecretTokens" -}}
{{- if not (hasKey . "_sprintfoundryResolvedSecretTokens") -}}
  {{- $existing := lookup "v1" "Secret" .Release.Namespace (include "sprintfoundry.secretName" .) | default dict -}}
  {{- $existingData := get $existing "data" | default dict -}}
  {{- $canGenerate := and .Values.secrets.create (not .Values.secrets.existingSecret) -}}
  {{- $internalToken := .Values.secrets.internalApiToken -}}
  {{- if not $internalToken -}}
    {{- if hasKey $existingData "SPRINTFOUNDRY_INTERNAL_API_TOKEN" -}}
      {{- $internalToken = (index $existingData "SPRINTFOUNDRY_INTERNAL_API_TOKEN" | b64dec) -}}
    {{- else if $canGenerate -}}
      {{- $internalToken = randAlphaNum 40 -}}
    {{- else -}}
      {{- $internalToken = "" -}}
    {{- end -}}
  {{- end -}}
  {{- $monitorReadToken := .Values.secrets.monitorApiToken -}}
  {{- if not $monitorReadToken -}}
    {{- if hasKey $existingData "SPRINTFOUNDRY_MONITOR_API_TOKEN" -}}
      {{- $monitorReadToken = (index $existingData "SPRINTFOUNDRY_MONITOR_API_TOKEN" | b64dec) -}}
    {{- else if $canGenerate -}}
      {{- $monitorReadToken = randAlphaNum 40 -}}
    {{- else -}}
      {{- $monitorReadToken = "" -}}
    {{- end -}}
  {{- end -}}
  {{- $monitorWriteToken := .Values.secrets.monitorWriteToken -}}
  {{- if not $monitorWriteToken -}}
    {{- if hasKey $existingData "SPRINTFOUNDRY_MONITOR_WRITE_TOKEN" -}}
      {{- $monitorWriteToken = (index $existingData "SPRINTFOUNDRY_MONITOR_WRITE_TOKEN" | b64dec) -}}
    {{- else if $canGenerate -}}
      {{- $monitorWriteToken = randAlphaNum 40 -}}
    {{- else -}}
      {{- $monitorWriteToken = "" -}}
    {{- end -}}
  {{- end -}}
  {{- $_ := set . "_sprintfoundryResolvedSecretTokens" (dict
    "internal" $internalToken
    "monitorRead" $monitorReadToken
    "monitorWrite" $monitorWriteToken
  ) -}}
{{- end -}}
{{- toYaml (get . "_sprintfoundryResolvedSecretTokens") -}}
{{- end }}

{{/*
Platform config ConfigMap name.
*/}}
{{- define "sprintfoundry.platformConfigMapName" -}}
{{- if .Values.platformConfig.existingConfigMap }}
{{- .Values.platformConfig.existingConfigMap }}
{{- else }}
{{- printf "%s-platform-config" (include "sprintfoundry.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Snapshot secret name.
*/}}
{{- define "sprintfoundry.snapshotSecretName" -}}
{{- if .Values.snapshot.existingSecret }}
{{- .Values.snapshot.existingSecret }}
{{- else }}
{{- printf "%s-snapshot-s3" (include "sprintfoundry.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Main container image.
*/}}
{{- define "sprintfoundry.image" -}}
{{- $registry := .Values.global.imageRegistry | default "" }}
{{- $repo := .Values.image.repository }}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry $repo $tag }}
{{- else }}
{{- printf "%s:%s" $repo $tag }}
{{- end }}
{{- end }}

{{/*
Event API container image (falls back to main image).
*/}}
{{- define "sprintfoundry.eventApiImage" -}}
{{- if .Values.eventApiImage.repository }}
{{- $registry := .Values.global.imageRegistry | default "" }}
{{- $repo := .Values.eventApiImage.repository }}
{{- $tag := .Values.eventApiImage.tag | default .Values.image.tag | default .Chart.AppVersion }}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry $repo $tag }}
{{- else }}
{{- printf "%s:%s" $repo $tag }}
{{- end }}
{{- else }}
{{- include "sprintfoundry.image" . }}
{{- end }}
{{- end }}

{{/*
Build the PostgreSQL connection URL.
*/}}
{{- define "sprintfoundry.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- $host := printf "%s-postgresql" .Release.Name }}
{{- $port := 5432 }}
{{- $user := .Values.postgresql.auth.username }}
{{- $pass := .Values.postgresql.auth.password }}
{{- $db := .Values.postgresql.auth.database }}
{{- printf "postgres://%s:%s@%s:%d/%s" $user $pass $host $port $db }}
{{- else }}
{{- $host := .Values.externalDatabase.host }}
{{- $port := .Values.externalDatabase.port | default 5432 }}
{{- $user := .Values.externalDatabase.user }}
{{- $pass := .Values.externalDatabase.password }}
{{- $db := .Values.externalDatabase.database }}
{{- printf "postgres://%s:%s@%s:%d/%s" $user $pass $host (int $port) $db }}
{{- end }}
{{- end }}

{{/*
Build the Redis connection URL.
*/}}
{{- define "sprintfoundry.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- $host := printf "%s-redis-master" .Release.Name }}
{{- printf "redis://%s:6379" $host }}
{{- else }}
{{- $host := .Values.externalRedis.host }}
{{- $port := .Values.externalRedis.port | default 6379 }}
{{- if .Values.externalRedis.password }}
{{- printf "redis://:%s@%s:%d" .Values.externalRedis.password $host (int $port) }}
{{- else }}
{{- printf "redis://%s:%d" $host (int $port) }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Build the internal event-api URL.
*/}}
{{- define "sprintfoundry.eventSinkUrl" -}}
{{- $fullname := include "sprintfoundry.fullname" . }}
{{- printf "http://%s-event-api.%s.svc.cluster.local:%d/events" $fullname .Release.Namespace (int .Values.eventApi.port) }}
{{- end }}

{{/*
Project secret name.
*/}}
{{- define "sprintfoundry.projectSecretName" -}}
{{- $project := . }}
{{- if $project.existingSecret }}
{{- $project.existingSecret }}
{{- else }}
{{- printf "sprintfoundry-project-%s-secrets" $project.id }}
{{- end }}
{{- end }}

{{/*
Project runtime secret name.
*/}}
{{- define "sprintfoundry.projectRuntimeSecretName" -}}
{{- $project := . }}
{{- printf "sprintfoundry-project-%s-runtime-secrets" $project.id }}
{{- end }}

{{/*
Project ConfigMap name.
*/}}
{{- define "sprintfoundry.projectConfigMapName" -}}
{{- $project := . }}
{{- if $project.existingConfigMap }}
{{- $project.existingConfigMap }}
{{- else }}
{{- printf "sprintfoundry-project-%s-config" $project.id }}
{{- end }}
{{- end }}

{{/*
Project namespace.
*/}}
{{- define "sprintfoundry.projectNamespace" -}}
{{- $project := . }}
{{- default $project.id $project.namespace }}
{{- end }}

{{/*
Render the synthesized quickstart project when enabled.
*/}}
{{- define "sprintfoundry.quickstartProject" -}}
{{- if .Values.quickstart.enabled -}}
{{- $id := default "quickstart" .Values.quickstart.project.id -}}
{{- $name := default "SprintFoundry Quickstart" .Values.quickstart.project.name -}}
{{- $defaultNamespace := printf "%s-%s" .Release.Name $id | trunc 63 | trimSuffix "-" -}}
{{- $namespace := default $defaultNamespace .Values.quickstart.project.namespace -}}
{{- $repoUrl := default "https://github.com/octocat/Hello-World.git" .Values.quickstart.project.repoUrl -}}
{{- $defaultBranch := default "master" .Values.quickstart.project.defaultBranch -}}
{{- $runtimeProvider := default "codex" .Values.quickstart.runtime.provider -}}
{{- $runtimeMode := default "local_process" .Values.quickstart.runtime.mode -}}
{{- $modelProvider := default "openai" .Values.quickstart.model.provider -}}
{{- $modelName := default "gpt-5.2-codex" .Values.quickstart.model.name -}}
{{- $reasoningEffort := default "medium" .Values.quickstart.model.reasoningEffort -}}
{{- $apiKeys := dict -}}
{{- if .Values.quickstart.apiKeys.openaiKey }}
{{- $_ := set $apiKeys "openaiKey" .Values.quickstart.apiKeys.openaiKey -}}
{{- end }}
{{- if .Values.quickstart.apiKeys.anthropicKey }}
{{- $_ := set $apiKeys "anthropicKey" .Values.quickstart.apiKeys.anthropicKey -}}
{{- end }}
{{- $projectApiKeys := dict -}}
{{- if .Values.quickstart.apiKeys.openaiKey }}
{{- $_ := set $projectApiKeys "openai" "${OPENAI_API_KEY}" -}}
{{- end }}
{{- if .Values.quickstart.apiKeys.anthropicKey }}
{{- $_ := set $projectApiKeys "anthropic" "${ANTHROPIC_API_KEY}" -}}
{{- end }}
{{- $projectConfig := dict
  "project_id" $id
  "name" $name
  "stack" "text"
  "agents" (list "developer")
  "repo" (dict "url" $repoUrl "default_branch" $defaultBranch)
  "api_keys" $projectApiKeys
  "model_overrides" (dict
    "orchestrator" (dict "provider" $modelProvider "model" $modelName)
    "developer" (dict "provider" $modelProvider "model" $modelName)
  )
  "runtime_overrides" (dict
    "developer" (dict "provider" $runtimeProvider "mode" $runtimeMode "model_reasoning_effort" $reasoningEffort)
  )
  "planner_runtime_override" (dict
    "provider" $runtimeProvider
    "mode" $runtimeMode
    "model_reasoning_effort" $reasoningEffort
  )
  "budget_overrides" (dict
    "per_agent_tokens" 100000
    "per_task_total_tokens" 250000
    "per_task_max_cost_usd" 5
  )
  "branch_strategy" (dict
    "prefix" "feat/"
    "include_ticket_id" true
    "naming" "kebab-case"
  )
  "integrations" (dict
    "ticket_source" (dict "type" "prompt" "config" (dict))
  )
  "rules" (list)
-}}
{{- $project := dict
  "id" $id
  "namespace" $namespace
  "apiKeys" $apiKeys
  "resourceQuota" (dict "enabled" false)
  "config" $projectConfig
-}}
{{- toYaml $project -}}
{{- end -}}
{{- end }}

{{/*
Return the full project list, including an optional synthesized quickstart project.
*/}}
{{- define "sprintfoundry.projectsList" -}}
{{- $projects := .Values.projects | default (list) -}}
{{- $quickstartYaml := include "sprintfoundry.quickstartProject" . | trim -}}
{{- if $quickstartYaml }}
{{- $projects = append $projects ($quickstartYaml | fromYaml) -}}
{{- end }}
{{- toYaml $projects -}}
{{- end }}

{{/*
Validate chart values early so bad project contracts fail at render/install time.
*/}}
{{- define "sprintfoundry.validateValues" -}}
{{- $projects := include "sprintfoundry.projectsList" . | fromYamlArray -}}
{{- $seenIds := dict -}}
{{- $dispatch := .Values.dispatchController | default dict -}}
{{- $dispatchK8sMode := hasKey $dispatch "k8sMode" | ternary $dispatch.k8sMode true -}}
{{- range $index, $project := $projects }}
  {{- $projectId := required (printf "projects[%d].id is required" $index) $project.id -}}
  {{- if hasKey $seenIds $projectId }}
    {{- fail (printf "Duplicate project id %q detected in Helm values" $projectId) -}}
  {{- end }}
  {{- $_ := set $seenIds $projectId true -}}
  {{- $projectNamespace := default $projectId $project.namespace -}}
  {{- if not (or $project.config $project.existingConfigMap) }}
    {{- fail (printf "Project %q must set either config or existingConfigMap" $projectId) -}}
  {{- end }}
  {{- if and (not $dispatchK8sMode) $project.existingSecret (ne $projectNamespace .Release.Namespace) }}
    {{- fail (printf "Project %q uses existingSecret across namespaces, which is not supported when dispatchController.k8sMode=false. Mirror the secret into the release namespace or use chart-managed apiKeys/externalSecret." $projectId) -}}
  {{- end }}
  {{- if $project.config }}
    {{- if ne $project.config.project_id $projectId }}
      {{- fail (printf "Project %q config.project_id must match the Helm project id" $projectId) -}}
    {{- end }}
    {{- if not $project.config.repo.url }}
      {{- fail (printf "Project %q config.repo.url is required" $projectId) -}}
    {{- end }}
    {{- if not $project.config.repo.default_branch }}
      {{- fail (printf "Project %q config.repo.default_branch is required" $projectId) -}}
    {{- end }}
    {{- if not $project.config.integrations.ticket_source.type }}
      {{- fail (printf "Project %q integrations.ticket_source.type is required" $projectId) -}}
    {{- end }}
  {{- end }}
{{- end }}
{{- if .Values.quickstart.enabled }}
  {{- if not .Values.quickstart.project.repoUrl }}
    {{- fail "quickstart.project.repoUrl is required when quickstart.enabled=true" -}}
  {{- end }}
  {{- if not .Values.quickstart.project.defaultBranch }}
    {{- fail "quickstart.project.defaultBranch is required when quickstart.enabled=true" -}}
  {{- end }}
  {{- if and (eq (default "openai" .Values.quickstart.model.provider) "openai") (not .Values.quickstart.apiKeys.openaiKey) }}
    {{- fail "quickstart.apiKeys.openaiKey is required when quickstart.model.provider=openai" -}}
  {{- end }}
  {{- if and (eq (default "openai" .Values.quickstart.model.provider) "anthropic") (not .Values.quickstart.apiKeys.anthropicKey) }}
    {{- fail "quickstart.apiKeys.anthropicKey is required when quickstart.model.provider=anthropic" -}}
  {{- end }}
{{- end }}
{{- end }}
