# Deploying, in order

`docs/DEPLOY.md` explains the decisions and their consequences. This directory
holds the files you put **on the host**, and this page is the order to do it in.

Everything here has been exercised except the four steps marked **needs the
host** — those cannot be done from a developer machine, and nothing pretends
otherwise.

---

## Before you start

| | |
|---|---|
| A host | 2 vCPU and 2 GB is ample. The expensive operation is generating a document, which is CPU-bound. |
| A volume of 50 GB or more, mounted at `/srv/raiseroom/data` | It holds the database and every uploaded file. |
| DNS for `raiseroom.app` pointing at it | Caddy cannot get a certificate until this resolves. |
| Docker and the compose plugin | |

---

## 1 · The data directory — **needs the host**

```bash
sudo mkdir -p /srv/raiseroom/data/objects /srv/raiseroom/backups
sudo chown -R 1000:1000 /srv/raiseroom/data   # the `node` user in the image
```

`compose.override.yaml` in this directory bind-mounts that path in place of the
named volume in `compose.yaml`. Read the comment at the top of it for why: a
named volume is fine until something outside the container — a backup, a disk
check, Litestream — needs the files, and then it is a path inside
`/var/lib/docker` that nothing should be reaching into.

```bash
cp deploy/compose.override.yaml ./compose.override.yaml
```

Compose picks that file up by name, with no flag.

## 2 · The environment

```bash
cp .env.example .env
openssl rand -hex 32            # paste into STORAGE_SECRET
```

Four values, and the first one is the one you cannot get wrong twice:

| | |
|---|---|
| `STORAGE_SECRET` | Generate **once**. Put it in your secret manager the same minute. Changing it invalidates every download link in flight, including ones a counterparty is holding. |
| `BASE_URL=https://raiseroom.app` | Without it, links in email are relative, which works in a browser and not in an inbox. |
| `TRUST_PROXY=1` | Correct here **only because** Caddy terminates TLS in front. With nothing in front, the caller writes that header and picks their own rate-limit bucket. |
| `NODE_ENV=production` | Already set in `compose.yaml`. It turns on the `Secure` cookie flag and HSTS, and refuses the worked example outright. |

## 3 · TLS and the first start — **needs the host**

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
docker compose up -d
curl -s https://raiseroom.app/health
```

Expect exactly `{"ok":true,"state":"ok","checks":[…]}`. The app stays bound to
`127.0.0.1:8080`; Caddy is the only thing that reaches it.

## 4 · Prove the backup, which means proving the restore — **needs a second host**

The backup runs nightly from the timer in step 5. Take one by hand first:

```bash
docker compose exec -T app node tools/backup.mjs \
  --data-dir /data --dest /backups --retain-days 35
```

`/backups` is the second bind mount in `compose.override.yaml`, deliberately not
a directory under `/data`: a backup written onto the volume it is backing up
fills the volume it exists to protect, and then the disk alert fires because of
the safety measure.

Then ship a set to a second machine and put it back:

```bash
node tools/restore.mjs --from <the set> --data-dir /srv/raiseroom/data --dry-run
node tools/restore.mjs --from <the set> --data-dir /srv/raiseroom/data
```

**Then sign in.** The command checks that the data is readable and coherent; only
signing in checks that the application is happy with what it found. Both halves
of the drill are in the checklist because both have caught things.

The round trip — backup from a live database, restore to a clean directory, and
a second process serving every page and opening every document from the restored
state — is covered by `test/backup.test.js` and was run end to end before this
was written. What it has **not** been run against is two separate machines, which
is the only part that tests your volume, your permissions and your transfer.

## 5 · The timers

```bash
sudo cp deploy/raiseroom-*.service deploy/raiseroom-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now raiseroom-backup.timer raiseroom-watch.timer
systemctl list-timers 'raiseroom-*'
```

On a host without systemd, `crontab.example` does the same thing with the same
commands.

## 6 · Make the alert wake somebody — **needs a URL from you**

`tools/watch.mjs` exits 1 when something needs a person, and until that exit code
reaches a human it is a log file. Two ways, and you want one of them:

- **A webhook.** Put a Slack or PagerDuty URL in `/etc/raiseroom/alert.env` as
  `ALERT_WEBHOOK=…`; `raiseroom-alert@.service` posts to it when either timer
  fails. Both units already declare `OnFailure=`.
- **An uptime service.** Point one at `https://raiseroom.app/health` and alert on
  non-200 twice. This catches less — it cannot see `"state":"degraded"`, which is
  the condition where the site is up and every upload is silently failing — so
  run the timer as well, not instead.

## 7 · Litestream — recommended

```bash
sudo cp deploy/litestream.yml /etc/litestream.yml
sudo systemctl enable --now litestream
```

Fill in the bucket and credentials first. This is what turns "restore to last
night" into "restore to any minute", and it is the cheaper of the two reasons
people reach for Postgres — see the section in `docs/DEPLOY.md` before anyone
plans that.

---

## What this directory does not cover

- **Shipping backups off the box.** `tools/backup.mjs` writes to a local path and
  says `encrypted: false` in its own output, every run, so it cannot be mistaken
  for the whole job. The step that moves a set to object storage is the step that
  encrypts it, and it needs credentials this repository does not have.
- **The restore drill on a second host.** Step 4.
- **Log shipping.** `watch.mjs` reports it `unchecked` rather than passed, so a
  green run never implies it is done. An unhandled failure prints a reference
  that the error page also shows, which is only useful if the logs are somewhere
  searchable.
