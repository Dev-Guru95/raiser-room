# RaiseRoom.
#
# One stage, because there is nothing to build: the product is ES modules with
# no dependencies and no transpilation, so a build stage would copy files from
# one image to another and call it a pipeline.
#
# WHAT THIS IMAGE DOES NOT CONTAIN
#
# No Chromium. Documents are generated as HTML and rendered to PDF by a separate
# step that is not wired in yet; adding a browser here would triple the image
# for a capability nothing calls. When PDF rendering is wired up it belongs in
# its own image with its own memory limit, because a renderer that runs out of
# memory should not take the web process down with it.

FROM node:22-bookworm-slim

# node:sqlite is behind a flag in 22.x. It is set here rather than in the start
# command so that `docker exec … node tools/usage.mjs` works without anybody
# having to remember it.
ENV NODE_OPTIONS=--experimental-sqlite \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# package.json alone first. It changes rarely, so the layer below it is reused
# on every deploy that only changes source — which is every deploy.
COPY package.json ./

COPY src ./src
COPY db ./db
COPY tools/fonts ./tools/fonts
COPY tools/usage.mjs ./tools/usage.mjs
# The operational commands, in the image because that is where /data is mounted.
# A backup taken from the host would have to reach inside a volume; taken from
# in here it is just a path. `tools/watch.mjs` stays out deliberately — it is run
# from outside against the public URL, so that it exercises TLS and the proxy
# rather than the loopback interface they hide.
COPY tools/backup.mjs ./tools/backup.mjs
COPY tools/restore.mjs ./tools/restore.mjs
COPY server.mjs ./server.mjs

# The fonts are served by the application itself and are not optional: pages
# fetch nothing from a third party, deliberately, so that no third party learns
# who is reading a diligence file and when. An image without them renders in
# whatever the reader's browser falls back to.
RUN test -n "$(ls -A tools/fonts)" || (echo 'tools/fonts is empty — the brand faces are missing' && exit 1)

# Writable state. Both are mount points in any real deployment; the directory is
# created here so a container started with no volume fails on the first write
# rather than at an unpredictable later moment.
RUN mkdir -p /data /data/objects && chown -R node:node /data
ENV DATABASE_FILE=/data/raiseroom.db \
    STORAGE_DIR=/data/objects

# Never root. An uploaded file is bytes from the internet sitting on this
# filesystem, and the process that writes it should not be able to write
# anywhere else.
USER node

EXPOSE 8080

# Against the application's own readiness endpoint, which runs a query rather
# than reporting that the process is up. A check that passes the moment the
# container starts tells you nothing you did not already know — see
# src/web/health.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No init process and no process manager. The server handles SIGTERM itself and
# closes the listener before exiting, so a request in flight finishes instead of
# being cut off mid-write — wrapping it in something that kills on the first
# signal would undo that.
CMD ["node", "server.mjs"]
