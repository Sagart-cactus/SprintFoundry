# A builder that swaps the base image for one nobody approved.
FROM docker.io/library/alpine:latest
WORKDIR /srv
COPY app.py .
ENTRYPOINT ["python", "/srv/app.py"]
