# ReelVocab Privacy Policy

Last updated: 2026-09-22

Developer: Benhur Okur
Contact: benhurokur0@gmail.com

## Summary

The developer collects no data. The extension has no server and no analytics. No data is sold or shared by the developer.

The extension keeps some data in your browser, described below. It sends caption text to Mistral AI only when you process a video with your own API key.

## Data stored on your device

The extension stores the following in `chrome.storage.local`. This storage belongs to this browser profile and is not synced to other devices.

- **Mistral API key.** You enter it on the settings page. The extension stores the key as you typed it, without encrypting it, so treat it as readable by anyone with access to your browser profile. We recommend creating a separate key for this extension that you can revoke in your Mistral account at any time. To delete the key, clear the field on the settings page and save. This also removes the extension's permission to contact Mistral; if that fails, the settings page says so.
- **Results cache.** After a video is processed with your key, the extension stores:
  - the video ID
  - the caption lines that were processed
  - the listed expressions and their explanations
  - the caption track name and whether it was auto-generated
  - a run summary (counts and error codes)

  Only runs where every section succeeded are saved. If you process the same video again, the new result replaces the old one.
- **"Wrong" marks.** When you mark an item as wrong, the extension stores the video ID, the expression, its explanation, the caption line it came from, its time in the video, and when you marked it. These records are not deleted automatically.
- **Panel position.** This is where you moved the panel on the screen. Double-clicking the panel header resets it.

In version 0.1, there is no button for deleting the cache or the "wrong" marks. To delete all of this data, remove the extension. Chrome removes an extension's stored data when the extension is removed; this is Chrome's behavior, not something the extension controls.

## Data sent to third parties

### Mistral AI

The extension contacts Mistral AI (`https://api.mistral.ai`) only when you process a video that is not one of the bundled samples, using your own API key.

What is sent, one section of about 20 caption lines at a time:

- the text of that video's caption lines
- a fixed set of instructions for the model, the same for every user
- the name of the model to use
- your API key, in the `Authorization` header

The extension does not send the video ID, the video title, the page URL, caption timings, or any information about you. Like any web request, the connection itself is visible to Mistral, and your API key identifies your Mistral account.

Mistral's own terms and privacy policy apply to this data: [Mistral AI Privacy Policy](https://legal.mistral.ai/terms/privacy-policy).

### YouTube

To get the caption text, the extension downloads the caption file from inside the YouTube page, using the same address the YouTube player requested. This request goes between your browser and YouTube, and YouTube's privacy policy applies to it.

### Sample videos

The four bundled sample videos use results that ship inside the extension. Opening them makes no network requests from the extension: it does not download captions and does not call a model.

## Clipboard

The "copy" button writes the current list and your "wrong" marks to your clipboard as JSON. This happens only when you click the button. The data is not sent anywhere.

## Permissions

The extension requests `storage`, `activeTab` and `scripting`. It also asks for optional access to `https://api.mistral.ai/*` when you save an API key. It has no standing access to YouTube pages: scripts run on a YouTube tab only after you click the extension icon. See [Permissions and privacy in the README](README.md#permissions-and-privacy) for what each permission is used for.

## Chrome Web Store User Data Policy

The use of information received by this extension adheres to the Chrome Web Store User Data Policy, including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements. In particular:

- Data is used only to provide the extension's single purpose: explaining expressions in YouTube videos whose meaning can't be guessed from their words.
- Data is not transferred to anyone except as described above (Mistral AI, only when you use your own key), and is not sold.
- Data is not used for advertising, and not used to determine creditworthiness or for lending.
- The developer does not read this data and never receives it.

## Changes

Any change to this policy will be published in this file, with a new "Last updated" date.
