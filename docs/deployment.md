# Deployment

The DICOM Viewer is a static site. It has no server code, no Worker, and no
Function. GitHub Actions builds the site. Cloudflare Pages serves it at
https://dicom.soofgolan.com.

This document has two parts. The first part describes the automatic system. The
second part is the one-time setup that the repository owner must do by hand.

## The automatic system

Two workflows do all repeated work.

`.github/workflows/ci.yml` runs on each push and on each pull request. It runs
`vp check` and `vp test --run --passWithNoTests`.

The `--passWithNoTests` flag is temporary. This repository has no test file
yet, and Vitest exits with an error on an empty suite. Remove the flag after
`src/core` gets its first test.

`.github/workflows/deploy.yml` runs on each push to `main` and on each pull
request. It runs `vp build` and then deploys `dist/`.

A push to `main` makes a production deployment at https://dicom.soofgolan.com.
A pull request makes a preview deployment at a temporary URL. A bot writes that
URL into a comment on the pull request, and updates the comment on each push.

Pull requests from forks do not get a preview. GitHub does not give repository
secrets to a fork, so the deploy job skips them.

### Versions

| Item                         | Version                |
| ---------------------------- | ---------------------- |
| `voidzero-dev/setup-vp`      | `v1`                   |
| `cloudflare/wrangler-action` | `v4`                   |
| `wrangler`                   | `4` (latest `4.118.0`) |
| `actions/checkout`           | `v6`                   |
| `actions/github-script`      | `v9`                   |

## Cloudflare Pages or Workers static assets

Cloudflare has two products that serve a static site. Pages is the older one.
Workers with static assets is the newer one.

Pages is not deprecated. Cloudflare still documents it as available on all
plans, and the dashboard still creates new Pages projects. But Cloudflare now
puts new platform features into Workers first. The Pages limits page sends
larger accounts to Workers, and Cloudflare publishes a Pages to Workers
migration guide. In practice Pages is in maintenance.

This repository uses Pages, because the request was for Pages, and because
Pages is the smaller setup for a purely static site. Pages also accepts a
custom domain whose zone lives outside Cloudflare. Workers does not.

The Workers configuration is ready in `wrangler.workers.jsonc`. The section
"Move to Workers static assets" explains the change. Both products read
`_headers` and `_redirects`, so the security headers move without an edit.

**Recommendation:** stay on Pages now. Move to Workers when this site needs a
feature that only Workers has. Examples are Durable Objects, Cron Triggers, and
gradual deployments. None of them apply to a static viewer.

## Why GitHub Actions builds the site

Cloudflare can build a project itself, through its Git integration. This
repository does not use that option. The `vp` CLI is the reason.

Vite+ has no plain npm package that `npx` or `pnpm dlx` can run. The two
supported installers are a shell script (`curl -fsSL https://vite.plus | bash`)
and a GitHub Action (`voidzero-dev/setup-vp`). The Cloudflare build image
documents no supported way to install a global CLI from a shell script. It also
ships Node 22 and pnpm 10 by default, and this project needs Node 24 and pnpm 11.

GitHub Actions has the first-party `setup-vp` action. That action installs
`vp`, pins Node, and caches the pnpm store. It reads the Vite+ version from the
`vite-plus` catalog entry in `pnpm-workspace.yaml`, so CI and a laptop use the
same version.

### The fallback build command

The `vite-plus` devDependency also ships a local `vp` binary at
`node_modules/.bin/vp`. This command builds the site with only Node on the
`PATH`, and with no global install:

```bash
pnpm install --frozen-lockfile
./node_modules/.bin/vp build
```

This command was tested in this repository and it produced the same `dist/`.
Use it if `setup-vp` ever breaks, or if the build ever moves into the
Cloudflare build image.

## One-time setup

The steps below are manual. Do them once, in order.

Tasks 1, 2, 3, and 5 need a login to the Cloudflare dashboard. Tasks 4 and 7
need admin rights on the GitHub repository. Task 6 needs write access to the
repository.

CAUTION: Do not put the API token into a file in this repository. Copy it from
the Cloudflare dashboard straight into the GitHub secret field.

### Task 1 — Create the Pages project

The Cloudflare account owner must do this task.

1. Open https://dash.cloudflare.com and sign in.
2. Go to **Workers & Pages**.
3. Select **Create**.
4. Select the **Pages** tab.
5. Select **Upload assets**.
6. Enter the project name `dicom`.
7. Select **Create project**.
8. Upload any single file, because the form needs one. The first real deploy
   replaces it.
9. Open the project, then go to **Settings** > **Builds & deployments**.
10. Set the production branch to `main`.

The project name must be `dicom`. It must match `name` in `wrangler.jsonc` and
`CLOUDFLARE_PROJECT_NAME` in `.github/workflows/deploy.yml`.

As an alternative to steps 2 to 10, run this command on a machine that has
Wrangler and a Cloudflare login:

```bash
npx wrangler pages project create dicom --production-branch=main
```

### Task 2 — Create the API token

The Cloudflare account owner must do this task.

1. Go to **My Profile** > **API Tokens**.
2. Select **Create Token**.
3. Select **Custom token**, then **Get started**.
4. Name the token `dicom-pages-deploy`.
5. Under **Permissions**, set the one row to **Account**, **Cloudflare Pages**,
   **Edit**.
6. Under **Account Resources**, set **Include** and the account that owns the
   `dicom` project.
7. Leave **Zone Resources** empty. A deploy needs no zone permission.
8. Select **Continue to summary**, then **Create Token**.
9. Copy the token value. Cloudflare shows it one time only.

That single permission row is the complete minimum. Do not add
**Workers Scripts: Edit** while the project stays on Pages.

### Task 3 — Find the account ID

The Cloudflare account owner must do this task.

1. Go to **Workers & Pages**.
2. Read the account ID in the right-hand panel.
3. Copy the account ID. It is a 32-character hexadecimal string.

The account ID is not a secret, but this setup stores it as one. That keeps it
out of public workflow logs.

### Task 4 — Add the two GitHub secrets

A GitHub repository admin must do this task.

1. Open https://github.com/soof-golan/dicom/settings/secrets/actions.
2. Select **New repository secret**.
3. Enter the name `CLOUDFLARE_API_TOKEN`.
4. Paste the token from Task 2.
5. Select **Add secret**.
6. Select **New repository secret** again.
7. Enter the name `CLOUDFLARE_ACCOUNT_ID`.
8. Paste the account ID from Task 3.
9. Select **Add secret**.

The two names must match the workflow exactly. The workflow reads
`${{ secrets.CLOUDFLARE_API_TOKEN }}` and `${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`.

### Task 5 — Add the custom domain and the DNS record

The Cloudflare account owner must do this task. Do it after the first
production deploy, so that the project has content.

1. Go to **Workers & Pages**, then open the `dicom` project.
2. Go to **Custom domains**.
3. Select **Set up a domain**.
4. Enter `dicom.soofgolan.com`.
5. Select **Continue**.
6. Select **Activate domain**.

`dicom.soofgolan.com` is a subdomain, so the zone `soofgolan.com` does not need
to be on Cloudflare.

If `soofgolan.com` is a zone on the same Cloudflare account, Cloudflare adds the
DNS record after step 6. Make sure that the record matches this table.

If `soofgolan.com` uses another DNS provider, add this record by hand at that
provider:

| Type    | Name    | Content           | Proxy   |
| ------- | ------- | ----------------- | ------- |
| `CNAME` | `dicom` | `dicom.pages.dev` | Proxied |

CAUTION: Do not add the CNAME record before step 6. A record that points at
Pages without a registered custom domain returns HTTP error 522.

### Task 6 — Set the R2 hostname in the security policy

1. Open `public/_headers`.
2. Find `R2-BUCKET-HOSTNAME.example.com` in the `connect-src` directive.
3. Replace it with the real public hostname of the R2 bucket.
4. If this site never calls R2, remove that hostname instead.
5. Commit the change.

Until this task is complete, the browser blocks every request to R2.

### Task 7 — Merge this pull request

1. Make sure that Task 4 is complete.
2. Merge the pull request into `main`.
3. Open the **Actions** tab and watch the **Deploy** workflow.
4. Open https://dicom.soofgolan.com after the workflow reports success.

## The `_headers` file

`public/_headers` is a plain text file. Vite copies it into `dist/`, and
Cloudflare Pages reads it and drops it. The file is never served.

The syntax is a path pattern at column 0, then indented `Name: value` lines.
Cloudflare documents one comment form: a whole line that starts with `#`. There
is no end-of-line comment form. Every directive is therefore explained here and
not in the file. A file can hold 100 rules, and each line can hold 2,000
characters.

A request that matches more than one pattern gets the headers of every match.

### Caching

| Pattern               | Header                                               | Reason                                                                                           |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/assets/*`           | `Cache-Control: public, max-age=31536000, immutable` | Vite puts a content hash in each filename, so the bytes at a URL never change.                   |
| `/index.html` and `/` | `Cache-Control: no-cache`                            | The browser must revalidate the HTML. A stale copy points at assets that a later deploy removed. |

`no-cache` does not mean "do not store". The browser stores the file and asks
the server on each load. Pages answers with HTTP 304 when nothing changed.

### Security headers

| Header                       | Value                                                          | Reason                                                                                                    |
| ---------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `X-Content-Type-Options`     | `nosniff`                                                      | The browser must obey the declared `Content-Type`. It stops a MIME confusion attack.                      |
| `Referrer-Policy`            | `no-referrer`                                                  | The browser sends no `Referer` header. This site handles medical images, so no other host learns a URL.   |
| `Permissions-Policy`         | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | An empty list turns the feature off for this document and for every frame. The viewer needs none of them. |
| `X-Frame-Options`            | `DENY`                                                         | No site can put this page in a frame. It is the older twin of `frame-ancestors`.                          |
| `Cross-Origin-Opener-Policy` | `same-origin`                                                  | A page that this site opens loses its `window.opener` reference. See the next section.                    |

### Content-Security-Policy

| Directive                   | Value                                                       | Reason                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-src`               | `'self'`                                                    | Everything not named below can load from this origin only.                                                                                                       |
| `script-src`                | `'self' 'wasm-unsafe-eval'`                                 | Only scripts from this origin can run. `'wasm-unsafe-eval'` lets WebAssembly compile. It does not enable `eval()` for JavaScript. No third-party script can run. |
| `style-src`                 | `'self' 'unsafe-inline'`                                    | Tailwind ships one stylesheet from this origin. `'unsafe-inline'` covers inline `style` attributes that React writes.                                            |
| `img-src`                   | `'self' data: blob:`                                        | Canvas output and decoded DICOM frames become `blob:` and `data:` images.                                                                                        |
| `font-src`                  | `'self' data:`                                              | Fonts come from this origin or from an inline `data:` URL.                                                                                                       |
| `media-src`                 | `'self' data: blob:`                                        | Same reason as `img-src`, for video and audio elements.                                                                                                          |
| `worker-src`                | `'self' blob:`                                              | Vite emits Web Workers as files on this origin. A worker built at run time needs `blob:`.                                                                        |
| `child-src`                 | `'self' blob:`                                              | Older browsers read `child-src` instead of `worker-src`.                                                                                                         |
| `manifest-src`              | `'self'`                                                    | A web app manifest can come from this origin only.                                                                                                               |
| `connect-src`               | `'self' blob: data: https://R2-BUCKET-HOSTNAME.example.com` | `fetch`, `XMLHttpRequest`, and WebSocket targets. Replace the placeholder with the R2 bucket hostname. See Task 6.                                               |
| `object-src`                | `'none'`                                                    | No `<object>`, `<embed>`, or `<applet>`. These elements bypass other directives.                                                                                 |
| `base-uri`                  | `'self'`                                                    | An injected `<base>` tag cannot move relative URLs to another host.                                                                                              |
| `form-action`               | `'self'`                                                    | A form cannot post to another host.                                                                                                                              |
| `frame-ancestors`           | `'none'`                                                    | No site can frame this page. It stops clickjacking.                                                                                                              |
| `upgrade-insecure-requests` | (no value)                                                  | The browser rewrites any `http:` subresource URL to `https:`.                                                                                                    |

The policy allows no third-party script. It has no `'unsafe-eval'`, no
`'unsafe-inline'` in `script-src`, and no host allowance in `script-src`. The
built `dist/index.html` contains no inline script, so no hash or nonce is
needed.

### A header that Pages adds

Pages adds `Access-Control-Allow-Origin: *` to every static asset by default.
This file does not remove it. Any site can therefore read the public build
output. That is acceptable for open-source static files. To remove it, add
`! Access-Control-Allow-Origin` under the `/*` rule.

## Cross-origin isolation (COOP and COEP)

`SharedArrayBuffer` needs a cross-origin isolated page. A page becomes
cross-origin isolated only with both of these headers:

```txt
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

WebAssembly threads need `SharedArrayBuffer`, so multi-threaded ONNX Runtime
Web on the wasm backend needs both headers.

**Recommendation:** ship `Cross-Origin-Opener-Policy: same-origin` now, and
leave `Cross-Origin-Embedder-Policy` off. `public/_headers` matches this
position.

The reasons follow.

COOP alone is safe here. It only cuts the `window.opener` link between this
page and a page that it opens. This site opens no popup and uses no OAuth
flow. COOP alone also gives no cross-origin isolation, so it enables nothing
yet.

COEP is the part that breaks things. Under `require-corp` the browser blocks
every cross-origin subresource that does not carry a
`Cross-Origin-Resource-Policy` header. The R2 bucket is the first casualty.

WebGPU does not need cross-origin isolation. Neither does WebGL, nor
single-threaded WebAssembly. The viewer runs today without either header, so
COEP gives no benefit now, and it costs cross-origin loads.

The value `Cross-Origin-Embedder-Policy: credentialless` is a weaker option
that needs no `Cross-Origin-Resource-Policy` on the other host. Safari does not
support `credentialless`. It is not a cross-browser answer.

### How to turn on cross-origin isolation later

Do this task when the viewer needs wasm threads.

1. Add `Cross-Origin-Embedder-Policy: require-corp` under the `/*` rule in
   `public/_headers`.
2. Set `Cross-Origin-Resource-Policy: cross-origin` on every R2 object that the
   page loads.
3. Move any other cross-origin asset onto this origin, or give it the same
   header.
4. Deploy to a preview and open the browser console.
5. Read `crossOriginIsolated` in the console. The value must be `true`.
6. Look for `ERR_BLOCKED_BY_RESPONSE` errors in the network panel.

CAUTION: Step 2 is not optional. Without it, every R2 request fails after step
1, and the failure looks like a network error and not a policy error.

## Move to Workers static assets

Do this task only when Pages blocks a needed feature.

1. Remove `wrangler.jsonc`.
2. Rename `wrangler.workers.jsonc` to `wrangler.jsonc`.
3. In `.github/workflows/deploy.yml`, replace the `pages deploy` command.
   Production uses `deploy`. A preview uses `versions upload`.
4. Change the API token permission from **Cloudflare Pages: Edit** to
   **Workers Scripts: Edit**.
5. Add `dicom.soofgolan.com` as a custom domain on the Worker.
6. Remove the Pages project after the Worker serves traffic.

`wrangler.workers.jsonc` already sets
`"not_found_handling": "single-page-application"`. Pages does that fallback
without configuration. Workers does not.

## The `_redirects` file

`public/_redirects` holds comments and no rules. This is deliberate.

Pages serves `index.html` for an unknown path when the site has no top-level
`404.html` file. This site has none, so the fallback already works.

Do not add the common rule `/* /index.html 200`. Cloudflare states that
redirects apply even when an asset matches the request. That rule therefore
returns `index.html` for `/assets/index-<hash>.js`. Cloudflare also states that
redirects apply before headers. That rule therefore discards the whole
`_headers` file.

## Troubleshooting

**The deploy job did not run on a pull request.** The pull request comes from a
fork. GitHub does not give secrets to a fork, so the job skips it. Push the
branch to this repository instead.

**Wrangler reports `Project not found`.** The project name does not match.
Compare `--project-name` in `.github/workflows/deploy.yml` with the project
name in the Cloudflare dashboard. Both must be `dicom`.

**Wrangler reports an authentication error.** The token permission is wrong.
Make sure that the token has **Account**, **Cloudflare Pages**, **Edit**, and
that **Account Resources** includes the right account.

**A push to `main` produced a preview and not a production deployment.** The
production branch of the project is not `main`. Correct it under **Settings** >
**Builds & deployments**.

**The page is blank and the console reports a CSP error.** A resource is not in
the policy. Read the directive name in the console error. Then add the host to
that directive in `public/_headers`. The R2 placeholder is the usual cause. See
Task 6.

**The custom domain returns HTTP error 522.** The CNAME record exists, but
Cloudflare has no matching custom domain on the project. Complete Task 5.

**The browser serves an old page after a deploy.** The HTML is cached. Make
sure that the `/` and `/index.html` rules in `dist/_headers` are present. If a
Cache Rule on the zone caches HTML, remove that rule.

**The `setup-vp` step logs a fallback to `latest`.** The action did not resolve
the pinned Vite+ version. Make sure that `pnpm-lock.yaml` is committed
and current. Run `vp install` and commit the result.

**A deploy fails on the file count or the file size.** A Pages site on the free
plan holds 20,000 files. One file can be 25 MiB at most. Move large model
weights and sample data to R2.
