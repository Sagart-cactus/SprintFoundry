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
