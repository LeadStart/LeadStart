# Node + Chromium (Apify base) + Python/curl_cffi for the fingerprint tier.
# The base image ships Node 20, Playwright, and a matching Chromium, so the
# browser tier needs no separate download.
FROM apify/actor-node-playwright-chrome:20

# --- Python + curl_cffi (tiers 2–3: TLS/HTTP-2 fingerprint impersonation) ---
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
# --break-system-packages: Debian 12 marks the system Python externally-managed;
# this is a single-purpose container so a global install is fine.
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    && python3 -c "from curl_cffi import requests; print('curl_cffi ok')"
USER myuser

# --- Node deps (tsx runs the TypeScript directly; no build step) ---
COPY --chown=myuser:myuser package*.json ./
RUN npm install --no-audit --no-fund --loglevel=error
COPY --chown=myuser:myuser . ./

# The base image points Playwright at its bundled Chromium.
ENV FINGERPRINT_PYTHON=python3
CMD ["npm", "start"]
