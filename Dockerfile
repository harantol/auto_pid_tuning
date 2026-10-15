# The web app, as served on S13 and on the Hugging Face Space.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock README.md ./
COPY vendor ./vendor
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

# Set by CI from version.py: the image has no git history to count merges from.
ARG APP_VERSION=dev
ENV AUTO_PID_TUNING_VERSION=$APP_VERSION PATH="/app/.venv/bin:$PATH"

# Hugging Face Spaces run the image as uid 1000.
USER 1000
EXPOSE 7860
CMD ["auto-pid-tuning-web", "--host", "0.0.0.0", "--port", "7860", "--no-browser"]
