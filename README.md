# ReelVocab

A Chrome extension that lists the expressions in a YouTube video whose meaning you can't guess from their words, and explains what each one means in that scene.

<!-- screenshot -->

## What it does

It is aimed at B1–B2 learners of English. On a YouTube video page, click the extension icon to open the side panel. On the four sample videos, reviewed results appear right away. On other videos, click **Prepare this video**: the extension reads the English captions and shows how many caption lines and sections it will process. Then click **Start**. A video you have already processed loads from the local cache, with no model call.

The result is a list of items: idioms, phrasal verbs, slang, words used in a scene-specific sense, and rare words. Each item shows its meaning in that scene, and clicking it jumps to that moment in the video. While the video plays, the panel highlights the current item.

From the panel you can also:

- mark an item as wrong (stored only in your browser),
- copy the list to the clipboard as JSON.

## What it doesn't do

- It doesn't make every word clickable. It lists only expressions whose meaning is hard to predict from their parts.
- It only works on videos whose source language is English. Translated captions are not used.
- It doesn't retry a failed section. If some sections fail, the panel says which ones.

## Try it

Four sample videos are bundled with the extension. They work without an API key and without signing up. Their items were processed in advance, and a person checked them by hand. The settings page also lists them.

| Video | Items |
|---|---|
| [House of Cards](https://www.youtube.com/watch?v=l2NxH4hke_I) | 19 |
| [Vogue](https://www.youtube.com/watch?v=Bl5630CeYFs) | 65 |
| [Game of Thrones](https://www.youtube.com/watch?v=uvX4k_3Cmvs) | 8 |
| [Antarctica vlog](https://www.youtube.com/watch?v=EDap9qxb96k) | 64 |

To process any other video, you need your own Mistral API key. **The key must belong to a paid Mistral account.** A free-tier key can't access the model this extension uses (`mistral-large-2512`), so those requests are rejected.

## Install

Chrome Web Store: *link will be added after publication.*

Until then, load it unpacked (Chrome 114 or later):

1. Build it (see [Development](#development)).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.
4. Open a YouTube video and click the extension icon.

Clicking the icon on any page other than YouTube opens the settings page.

## Permissions and privacy

| Permission | Why |
|---|---|
| `storage` | Keeps your API key, the local results cache, your "wrong" marks and the panel position in `chrome.storage.local`. |
| `activeTab` | Gives temporary access to the current tab when you click the icon. |
| `scripting` | Adds the extension's scripts to that tab after the click. |
| `https://api.mistral.ai/*` (optional) | Needed only if you use your own key. Chrome asks for it when you save the key and removes it when you delete the key. |

The extension has no `host_permissions` and no `content_scripts`, so Chrome shows no site-access warning when you install it. Scripts run on a YouTube tab only after you click the icon.

- Your API key is stored only in this browser (`chrome.storage.local`, not `sync`).
- Caption text is sent only to Mistral (`api.mistral.ai`), and only when you process a video with your own key. Sample videos make no model calls.
- The results cache and the "wrong" marks keep caption lines and video IDs in this browser. In v0.1, the only way to delete them is to remove the extension.
- The developer collects nothing. There is no server and no analytics.

Full privacy policy: [PRIVACY.md](PRIVACY.md).

## How it works

1. **Captions.** The extension takes the caption URL from the request the YouTube player makes itself, then downloads the captions from that URL. It never builds a caption URL of its own. It uses manual captions when they exist and falls back to auto-generated ones otherwise. If the extension has to turn YouTube's captions on to get the text, it restores your caption setting afterward.
2. **Annotation.** The captions are split into sections of 20 caption lines. The sections go to the model one at a time, with a short pause between calls. Running them one at a time avoids hitting your key's rate limit.
3. **Validation.** The model's response is checked against a schema. Then six automated checks remove an item if:
   - its phrase doesn't appear anywhere in that section's captions,
   - it looks like a name (it starts with a capital letter in the middle of a sentence; abbreviations are exempt),
   - it is on a fixed list of phrases the model's instructions already say not to return,
   - the model's own explanation admits a problem (for example "fragment", "misheard" or "transcription"),
   - it is too long to be a single expression (more than 4 words, or 8 for idioms) or contains a censored word,
   - it repeats a phrase already listed in the same section; only one copy is kept.

   Nothing reaches the panel without passing these checks. As each section's results arrive, a phrase already listed in an earlier section of the video is hidden as a duplicate (same wording, ignoring case and spacing), and the first one is kept.
4. **Cache.** Results are cached locally, but only when every section succeeds. A partial result stays in the panel but isn't saved.

## Design decisions

| Decision | Why | Trade-off |
|---|---|---|
| The whole video is processed when you ask for it, not while you watch | Processing just ahead of the playhead breaks every time you skip ahead, and parallel calls can push your key past its rate limit. | A list shows each expression apart from its scene. Each item links back to that scene to make up for this. |
| One model call per section, not several runs with voting | Repeated runs filter out answers the model is unsure about, not wrong ones. The model has been measured giving the same wrong meaning on every run. | The list keeps some unnecessary items that voting would have dropped. |
| You bring your own API key; no key is built in | A key built into the extension can be extracted from the package, and the developer would pay for any misuse. | You need a key, and in practice a paid Mistral account. |
| Four pre-processed, reviewed sample videos ship with the extension | This is the only way to offer a trial with no signup that doesn't bill the developer. The samples also get a human review. | Sample results are cleaner than your own results. The panel labels sample results as reviewed so this stays visible. |

## Known limitations

When the source text is garbled, the model can confidently invent a meaning for it. These cases from the sample videos were removed in review. In each pair, the first phrase is what the captions said and the second is what the speaker actually said:

- **"heal"** → "yield" (House of Cards, auto-generated captions)
- **"day me"** → "debate me" (House of Cards, auto-generated captions)
- **"as cut as"** → "as cute as" (Antarctica vlog, *manual* captions)

The automated checks catch this only partly. The garbled phrase really is in the caption text, and the model usually sounds sure of itself. The sample videos had 178 items after the six checks above, and 156 were kept. A person removed 15 items, and 7 more were automatic duplicates across sections. That count describes one review, not the model's accuracy. **Results you get with your own key are not reviewed by anyone.** The panel marks them as machine-generated and possibly wrong, and you can mark items as wrong.

## Development

The build script uses Node.js (`esbuild`, `typescript`).

```sh
npm install
npm run build        # release build → dist/
npm run build:dev    # development build → dist/
npm run watch        # development build, rebuilds on change
npm run typecheck    # tsc --noEmit
npm run package      # release build, then zip → releases/reelvocab-<versionName>.zip
```

- **Release build** (`build`, `package`): it has no console test hook and doesn't log user content (raw model responses, item lists, caption tables). The build scans `dist/` to check this and fails if it finds any. It also checks the manifest, the version, the locale files and the bundled sample data.
- **Development build** (`build:dev`, `watch`): it includes the console test hook `window.__reelvocabTest(...)` and detailed logs, which are used for measurement.
- `npm run package` needs the system `zip` command (macOS or Linux). The zip name comes from `versionName` in `package.json`.

## License

MIT — see [LICENSE](LICENSE).

---

Arayüz Türkçe ve İngilizce; dil tarayıcı dilinden seçilir.
Desteklenen diller dışındaki tarayıcılarda arayüz İngilizce açılır.
