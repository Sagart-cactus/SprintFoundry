FROM docker.io/library/python:3.13-alpine
WORKDIR /srv
COPY app.py .
ENV INVOICES_MODE=evaluation
USER 65532
EXPOSE 8080
ENTRYPOINT ["python", "/srv/app.py"]
