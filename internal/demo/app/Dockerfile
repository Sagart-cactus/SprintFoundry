FROM docker.io/library/python:3.13-alpine@sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e
WORKDIR /srv
COPY app.py .
USER 65532
EXPOSE 8080
ENTRYPOINT ["python", "/srv/app.py"]
