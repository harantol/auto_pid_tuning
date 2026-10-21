# The web app as served on S13: static files, the analysis runs in the browser.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY app /usr/share/nginx/html

# Set by CI from version.py: the image has no git history to count merges from.
ARG APP_VERSION=dev
USER root
RUN printf '{"version": "%s"}\n' "$APP_VERSION" > /usr/share/nginx/html/version.json
USER 101

# The port S13's compose.yaml maps to 8787.
EXPOSE 7860
