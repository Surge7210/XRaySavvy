# Hooking up the Upload quiz (free)

The Upload page (`upload.html`) reads your notes on your phone and sends only the
**text** to a tiny free "Worker" on Cloudflare. The Worker holds your secret
Google Gemini key and asks Gemini to write the questions.

You do this **once**. It takes about 10 minutes. Everything here is free.

> ⚠️ **Two rules**
> 1. **Never paste your Gemini key into a chat, a text, a GitHub file, or this repo.** It only goes in the Cloudflare "Secret" box (step C).
> 2. **No patient info.** On the free tier, Google may use what you send to improve its products. Only upload class notes and slides.

---

## A. Get a free Gemini API key (Google AI Studio)

1. On your phone or computer, go to **https://aistudio.google.com** and sign in with a Google account.
2. Agree to the terms if it asks.
3. Tap **Get API key** (left menu, or the menu ☰ on a phone).
4. Tap **Create API key**. If it asks for a project, pick the default one or let it create one.
5. Tap **Copy** next to the key (it starts with `AIza…`).
6. Keep this tab open. You'll paste the key in step C. **Don't send it to anyone.**

You do **not** need to add a credit card. The free tier is enough.

## B. Make a free Cloudflare Worker

1. Go to **https://dash.cloudflare.com/sign-up** and make a free account (email + password). Confirm your email.
2. In the left menu, tap **Workers & Pages** (it may be under **Compute**).
3. Tap **Create** (or **Create application**).
4. Choose **Start with Hello World!** (the Hello World template).
5. Give it a name, like `xraysavvy-quiz`. Tap **Deploy**.
6. Tap **Continue to project** (or **Edit code**).
7. Tap **Edit code**. You'll see a code editor with a little sample program.
8. Open this file on GitHub: `worker/worker.js` in the XRaySavvy repo. Tap **Raw**, then select all and copy.
9. Back in the Cloudflare editor, **delete everything** that's there and **paste** the worker.js code.
10. Tap **Deploy** (top right). Wait for it to say it's deployed.

> A computer is easier for step 9, but a phone works too.

## C. Add your Gemini key as a Secret

1. Go back to your Worker's page (tap the back arrow or the Worker's name).
2. Tap **Settings**.
3. Find **Variables and Secrets** and tap **Add**.
4. **Type:** choose **Secret**.
5. **Variable name:** type exactly `GEMINI_API_KEY` (all caps, with the underscores).
6. **Value:** paste your key from step A.
7. Tap **Deploy** (or **Save and deploy**).

Your key is now hidden inside Cloudflare. Nobody can see it, not even on GitHub.

## D. Send me the Worker link

1. On your Worker's page, find its link. It looks like:
   `https://xraysavvy-quiz.YOUR-NAME.workers.dev`
2. (Optional check) Open that link in your browser. You should see something like
   `{"ok":true, ... "keySet":true}`. If it says `"keySet":false`, redo step C.
3. **Copy that link and send it to Cohort 26.** This link is **not** secret, so it's fine to share.
4. It gets pasted into `upload.html` at the top, in this line:
   `const WORKER_URL = 'PASTE_WORKER_URL_HERE';`
5. Then the "Not connected yet" message goes away and the **Make questions** button works.

---

## If something goes wrong

- **"Gemini's free tier is busy"**: you hit the per-minute limit. The page waits and keeps going on its own.
- **"Free daily limit is used up"**: wait until about 2 AM Central (midnight Pacific). Your questions so far are kept.
- **"Google rejected the API key"**: redo step C and paste the key again carefully.
- **"missing its GEMINI_API_KEY secret"**: step C wasn't saved or deployed. Do step C again.
- **Very few questions from a PDF**: it's probably a scanned PDF (pictures of text). Use the PowerPoint or a text PDF instead.

## Changing the AI model (only if needed)

At the top of `worker.js` is `const MODEL = 'gemini-3.5-flash-lite';`. If Google ever
retires that model, change it to another free model from
https://ai.google.dev/gemini-api/docs/models, then tap **Deploy** again.
