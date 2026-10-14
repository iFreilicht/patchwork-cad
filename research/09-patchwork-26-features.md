# Patchwork-26 Features demoed but unpublished?

<HUMAN-WRITTEN>

In the talk [Introducing Patchwork-26](https://www.youtube.com/watch?v=4UxGijnuXEs), Ink&Switch demo loads of new features of Patchwork that seem to be absent from the mainline patchwork repo that we've worked with so far.

## Simpler Pandoc converter

For example, in the following image, you can see a pandoc-based document conversion tool that is displayed in the right sidebar instead of in the center. Because of this, it works simiarly to the "Comments" or "Drafts" Panels in that it reacts directly to whatever document you have currently opened in the center pane.

![Pandoc & tools in right sidebar](./09-patchwork-26-features/pandoc-tools-in-right-sidebar.png)

This could be based on [patchwork-experiments/pandoc](/.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/pandoc), but the UI is much simpler because you don't have to select documents, just the output format. Additionally, the new tool has a little drag-and-drop-item of the converted document in the upper right corner that you can drag onto another document to embed it, into the left sidebar to create a new document from it or even out of the browser onto your desktop (at least on macOS, not sure about other OSes) to download it.

## Tools in the right sidebar

However, just the ability to install a tool into the right sidebar currently seems completely absent from the main branch of patchwork. Maybe it is possible and I just don't know any tools that will show up there, or this functionality is on a different branch, or maybe even on a fork of one of the contributors. Either way, this is very powerful functionality that I would like to explore. In the above screenshot you can see that there are more such tools, like "OpenSCAD Lens" and "Pixel Letters".

## Cards, Canvas, Map

One very powerful and frankly revolutionary feature from the demo is "Cards". This is also a tool that installs into the right sidebar, and it allows enriching static documents with dynamic behaviors. In the image below, you can see that a [patchwork-experiments/bullets](/.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/bullets) document is enhanced with an Embark, Place Finder and Routes card, which enable dynamic and reactive route planning based on the locations and times noted down in the bullets document. The specs for this are written in plain language, the actual code is written by an LLM based on that.

![Embark Cards in Canvas](./09-patchwork-26-features/cards-llm-spec-travel-planning.png)

You can also see that this bullets document was placed in a "Canvas" editor, something I also haven't seen yet, alongside a Map view, something I **also** haven't seen anywhere else yet.

This project seems to have been developed by the same guy who initially made [Embark](https://www.inkandswitch.com/embark/) (which was only ever a prototype for UX-research, I couldn't find any source code for this), so this entire project might only live on his github repo.

You can also see that Cards, similar to the simple pandoc converter above, lives in the right sidebar, so it always shows the cards for your current document and the inspector for the currently selected card, though you can also switch to a parts bin that (from what I can tell) shows all the cards you've ever used in your account, see the image below.

![Birdsighting Cards in Run Tracking](./09-patchwork-26-features/cards-bird-sightings.png)

This also shows another tool called "Run Tracking" which I haven't seen before, though I'm not particularly interested in that one. If we find it, great, if not, no loss.

Cards also has a global tab which contains cards that are active for any document, see below.

![Cards global tab](./09-patchwork-26-features/cards-global.png)

</HUMAN-WRITTEN>

