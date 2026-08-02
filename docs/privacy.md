<!--
  A lawyer has not reviewed this text.
  The owner of the project wrote it in plain language.
  It describes how the software behaves. It is not legal advice.
-->

# Privacy Policy

**Last updated: 2026-08-02**

## In short

- The viewer collects nothing about you. There is no server that receives your data.
- Your DICOM files stay on your device. The browser reads them and holds them in memory.
- The viewer saves your tutorial progress and your view preferences on your device, in `localStorage`.
- One optional feature downloads a large model file from Cloudflare. Cloudflare logs that request, as it does for any web request.
- You can delete all local state from inside the viewer, or from your browser settings.

The formal text follows.

## 1. Who runs the viewer

Soof Golan owns the viewer and wrote this policy. The viewer runs at
[dicom.soofgolan.com](https://dicom.soofgolan.com). The source code is at
[github.com/soof-golan/dicom](https://github.com/soof-golan/dicom).

## 2. What the viewer collects

Nothing.

The viewer has no backend server. It is a set of static files: HTML, JavaScript, and CSS. Your
browser downloads these files and runs them on your device.

There is no account, no login, and no user profile. There are no analytics, no telemetry, no
cookies, no tracking pixels, and no third-party embeds. The viewer sends no information about you
to anybody.

## 3. Your medical files

You open DICOM files with the file picker of your browser. The File API of the browser reads the
bytes on your device.

The viewer holds the image data in two places: the memory of the browser tab, and the textures of
your graphics card. Both places are temporary.

Your files never leave your device. The viewer does not upload them. There is no upload function
in the code, and there is no server that can accept one.

When you close the tab, the image data disappears. The viewer keeps no copy.

## 4. What the viewer stores on your device

The viewer writes a small amount of state to `localStorage` in your browser. This state stays on
your device. It never travels to a server.

The viewer stores two things:

- **Tutorial progress.** This records the tutorial steps that you finished, so the viewer does not
  repeat them.
- **View preferences.** These record your display settings, so the viewer opens in the same state
  next time.

No DICOM data goes into `localStorage`. No name, no email address, and no identifier goes into it.
The viewer creates no user ID and no session ID.

## 5. The optional model download

The viewer has an optional segmentation feature. This feature needs a machine-learning model
(SAM). The model file is several hundred megabytes.

If you turn this feature on, your browser downloads the model file from a Cloudflare R2 bucket
that I control. Your browser then caches the file, and a second download is not necessary.

The download moves in one direction only. It is a request for a static file. No DICOM data, no
`localStorage` state, and no information about your scans travels with that request.

Cloudflare hosts the file. As with any web request, Cloudflare receives and logs standard request
metadata. This metadata includes your IP address and your user agent string. Cloudflare holds
those logs under its own privacy terms.

I do not use those logs to build a profile of you.

## 6. Hosting

Cloudflare Pages serves the viewer as static files. The rule in section 5 applies to every page
load too. Cloudflare receives and logs the request, with your IP address and your user agent.

This is true for any static website. I cannot switch off the server logs of a host. The viewer
adds no tracking on top of them.

## 7. Sharing with other parties

There is nothing to share.

I do not sell your data. I do not rent it, and I do not give it away. This is more than a promise
about my behavior. It is a fact about the design: I never receive your data, so I hold nothing
that I can share.

Cloudflare is the only other party in the system. Cloudflare hosts the files. It receives the
request metadata that sections 5 and 6 describe, and nothing else.

## 8. Your rights over your data

Data protection law can give you the right to read, correct, export, or delete the personal data
that a company holds about you.

I hold no personal data about you. As a result, there is nothing for me to export and nothing for
me to delete. Section 10 explains how to delete the state on your own device.

## 9. Children

The viewer is a tool for education and for software work. It is not directed at children.

The viewer collects no personal data from anybody. As a result, it collects no personal data from
a child. There is no account to create and no form to fill in.

A parent or a guardian must decide whether a child can look at medical images.

## 10. How to delete your local state

You can delete the stored state at any time. Two methods work:

1. Open the settings of the viewer. Select the control that deletes the local data.
2. Open the settings of your browser. Delete the site data for `dicom.soofgolan.com`.

Method 2 also deletes the cached model file. If you turn the segmentation feature on again, the
browser downloads the model one more time.

## 11. Changes to this policy

This policy can change. The "Last updated" date at the top of this page shows the date of the last
change.

The Git repository holds the full history of this file. You can read every earlier version there.

## 12. Contact

Open an issue at [github.com/soof-golan/dicom](https://github.com/soof-golan/dicom/issues) for a
question about this policy.

---

The viewer is not a medical device. Read the [Terms and Conditions](terms.md) before you use it.

MIT License. Copyright (c) 2026 Soof Golan.
