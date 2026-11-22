FROM docker.io/library/python:3.13-alpine
WORKDIR /srv
COPY app.py .
USER 65532
EXPOSE 8080
ENTRYPOINT ["python", "/srv/app.py"]
