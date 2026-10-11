# Basic Idea and Literature

<HUMAN-WRITTEN>

I've done a bit of my own initial research and seem to have found a few interesting resources and facts. First, it seems that there are actually very few options for NURBS-engines out there. I thought OpenSCAD was one, but it works on polygon meshes instead. We absolutely do need NURBS-modelling, otherwise features like fillets, edge-selection or feature projection in sketches become incredibly hard to implement. Modelling MUST be mathematically accurate for a software like this to be a serious alternative to Fusion 360.

The best option I found is [RepliCAD](https://replicad.xyz/docs/intro), which is based on [OpenCascade.js](https://ocjs.org/docs/about). The latter page lists a few other projects using OpenCascade.js, which might be instructive.

The basic idea behind this project is to create a patchwork-compatible WYSIWYG CAD editor UI that is similar to Fusion 360 with regards to the editing experience, timeline, sketches, modelling features etc., but which stores its models as a JavaScript [automerge](https://automerge.org/) document containing calls to RepliCAD. Global parameters and each sketch and feature is just a section of code in that document. Feature parameters map cleanly to function parameters. This enables syncing, conflict resolution and collaborative editing.

Establishing this format as the default for 3D-models in patchwork also enables additional usecases. Some examples:
1. OpenSCAD-like Code-Editor+Model-Viewer as just a different view on the same model
2. Simple viewer of the final 3D-model that can be used to embed it into other documents
3. Parametrized viewer that allows you to modify only some selected global parameters to get the exact model you need and export it for 3D-printing

The best web-based CAD-package I've seen so far is [BasicCAD](https://basiccad.xyz/), which also loads VERY quickly. It probably uses a custom build of [OCCT](https://github.com/Open-Cascade-SAS/OCCT) instead of the prebuilt one OpenCascade.js provides. Maybe that's an option for us as well?

One thing I'm already quite certain about is how we handle units; we will always treat the bare floats as Millimeters. If we later add support for imperial units or using centimeters or meters as a base unit, we can do this with a bit of additional metadata and UI-support, but everything should be immediately converted to millimeters in the code before feeding anything to RepliCAD.

A few additions over Fusion 360 will also have to be supported. One is that we must support a "Custom Script"-Feature in the timeline so that code that's added in an external editor will be displayed properly in the WYSIWYG editor. The other is an "Embed"-Feature that allows embedding another document that isn't a 3D model anywhere. Other 3D-Models can be inserted into an assembly, this will work just like in Fusion.

A big complication will be advanced sketch features like projections and constraints. For our MVP, we will only support basic sketches (you enter point coordinates, radii, etc. manually), global parameters, parametrized features and a feature timeline.

</HUMAN-WRITTEN>

## Review

*Fact check and risk analysis of the section above.*

### Verified claims

**OpenSCAD is mesh-based.** Correct. The [OpenSCAD manual](https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/The_OpenSCAD_Language) says: "Curved surfaces are approximated by a series of flat surfaces" and "circular paths are approximated with polygons inscribed within a circle".

**There are few NURBS engines.** Correct for open-source engines that also run in the browser. [Wikipedia](https://en.wikipedia.org/wiki/Geometric_modeling_kernel) lists over a dozen geometric modelling kernels, almost all proprietary (Parasolid, ACIS, Autodesk's ShapeManager, etc.). The open-source ones it names are Open CASCADE, CGAL and SolveSpace. Other open-source options are less mature:
- [Fornjot](https://github.com/hannobraun/fornjot) was shut down: "This project has been shut down. Its goals were never reached."
- [truck](https://github.com/ricosjp/truck) (Rust, B-rep with NURBS, has a JS/wasm wrapper) offers booleans and STEP I/O, but its README lists no fillet operation.
- [verb](https://github.com/pboyer/verb) is "a library for creating and manipulating NURBS surfaces and curves". It has no solids or booleans.

That leaves OCCT as the only mature choice.

**We need NURBS.** Mostly correct, but the more important property is **B-rep**, i.e. explicit topology: faces, edges and vertices exist as selectable entities. Fillets, edge selection and projection depend on that. NURBS is how free-form surfaces are stored, while planes and cylinders are stored analytically. [BasicCAD](https://basiccad.xyz/) describes OCCT this way: "Parts are exact solids built from planes, cylinders and NURBS surfaces".

**Modelling must be "mathematically accurate".** Achievable only up to a tolerance. Every B-rep kernel works with floating-point tolerances. OCCT's [`Precision::Confusion()`](https://occt3d.com/dev/doc/refman/html/class_precision.html) is 1e-7, and "Two points are considered to be coincident if their distance is smaller than the tolerance of confusion." This is the same as in commercial kernels and no obstacle.

**RepliCAD is based on OpenCascade.js.** Correct. [replicad](https://replicad.xyz/docs/intro) "is an abstraction over opencascade". It is MIT-licensed and actively maintained: v1.1.0 was released on 2026-09-04 ([npm](https://www.npmjs.com/package/replicad)).

**The ocjs.org page lists other projects.** Correct. [ocjs.org](https://ocjs.org/docs/about) lists ArchiYou, BitByBit, CascadeStudio, Polygonjs, RepliCAD and OpenCascade.js-examples.

**BasicCAD probably uses a custom OCCT build "instead of the prebuilt one OpenCascade.js provides".** This cannot be verified. The site only says "OpenCascade (OCCT) … compiled to WebAssembly". Its code is obfuscated and its license forbids reverse-engineering, so I did not inspect it. The comparison is also partly wrong: replicad itself does not use a prebuilt OpenCascade.js. It ships a custom build, [`replicad-opencascadejs`](https://www.npmjs.com/package/replicad-opencascadejs) ("An opencascadejs build containing only the APIs necessary to run replicad"). Its [build script](https://github.com/sgenoud/replicad/blob/main/packages/replicad-opencascadejs/package.json) uses `ghcr.io/taucad/opencascade.js:canary-ebd263f1`, and that [commit](https://github.com/taucad/opencascade.js/commit/ebd263f1) is titled "Upgrade OCCT to 8.0.1". The original [OpenCascade.js](https://github.com/donalffons/opencascade.js) has been inactive since 2023: last stable npm release 1.1.1 in 2020, last push 2023-08. The [taucad fork](https://github.com/taucad/opencascade.js) (npm: [`libcascade`](https://www.npmjs.com/package/libcascade)) is maintained and is what replicad builds on.

Size of the replicad build (measured from the npm tarball): `replicad_single.wasm` is 22 MB raw, 7.2 MB gzip and 4.8 MB brotli. A smaller custom build is possible later, but not needed for the MVP. Load speed is mostly a caching question. The [openscad tool](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/openscad/README.md) caches its wasm via the Cache API so "subsequent loads are instant".

BasicCAD is closed source and proprietary ("PROPRIETARY AND CONFIDENTIAL", in its served JS), so it is only useful as a UX reference. For its 2D sketch constraints it uses "PlaneGCS: The 2D constraint solver from FreeCAD", which is available as [@salusoft89/planegcs](https://github.com/Salusoft89/planegcs) ("A webassembly wrapper for FreeCAD's 2D geometric solver", LGPL-2.1, maintained). That makes it a candidate for sketch constraints after the MVP.

**Bare floats are millimetres.** Sound. OCCT is unitless internally, and its STEP translator assumes millimetres by default. [OCCT STEP guide](https://occt3d.com/dev/doc/overview/html/occt_user_guides__step.html), on `xstep.cascade.unit`: "Normally it is MM; only those applications that work internally in units other than MM should use this parameter." On `write.step.unit`, it gives the default as MM.

**Other 3D models can be inserted into an assembly "just like in Fusion".** Not supported by replicad. Its [`createAssembly`](https://replicad.xyz/docs/api/functions/createAssembly) only returns an `AssemblyExporter` for exporting grouped shapes. Joints and their motion would have to be built by us.

### Is the basic idea sound?

Yes. Both parts of the idea are established practice:
- **Storing a model as code and editing it through a GUI** is exactly what Onshape does: "A Part Studio defines a build function, containing a function call for every feature … Part Studio regeneration, triggered when features are updated, is execution of the build function" ([FeatureScript intro](https://cad.onshape.com/FsDoc/intro.html)).
- **A code file as the source of truth, with a point-and-click UI on top,** is what Zoo does. "Every CAD function in Zoo Design Studio generates KCL" and models remain editable "with human-readable KCL as its source of truth" ([Zoo FAQ](https://zoo.dev/docs/faq)). Unlike our plan, Zoo needs a server: "An internet connection is required for modeling".

Running OCCT locally in wasm with automerge sync would be a real differentiator.

### Problems and risks

1. **Topological naming problem (the biggest risk).** A fillet must remember *which* edges it applies to, so "feature parameters map cleanly to function parameters" is only true for scalars. FreeCAD's [documentation](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Topological_naming_problem.md) describes "the issue of a shape changing its internal name after a modelling operation (pad, cut, union, chamfer, fillet, etc.)", which breaks dependent features. FreeCAD needed years to mitigate this ("The first stable release of FreeCAD to feature this new naming algorithm is 1.0").
   - replicad selects geometry with *finders*, i.e. geometric rules like `inPlane`, `containsPoint` or `ofCurveType` ([finders docs](https://replicad.xyz/docs/tutorial-overview/finders)). Its docs say nothing about stable references.
   - Onshape's answer is rule-based queries generated from UI picks: "The generated queries refer to the selected entities in a robust way so that features can be resistant to upstream changes" ([FeatureScript tutorial](https://cad.onshape.com/FsDoc/tutorials/create-a-slot-feature.html)).
   - OCCT has building blocks for this: modelling algorithms report `Modified`/`Generated`/`IsDeleted` history (these bindings exist in the replicad build), and OCAF's `TNaming` maintains "references to selected geometry even after these modifications" ([OCAF guide](https://occt3d.com/dev/doc/overview/html/occt_user_guides__ocaf.html)).
   
   How a click on an edge becomes a reference that survives rebuilds is researched and benchmarked in [03-topological-naming.md](03-topological-naming.md).

2. **Merging code as text.** An automerge document is JSON-like, so a "JavaScript automerge document" means code stored in text fields. Automerge merges strings character by character: the [automerge skill](../.claude/skills/working-with-automerge/SKILL.md) warns that a field should be an `ImmutableString` "so nobody accidentally gets character-level merging on it". That guarantees convergence, but not valid code. [COAST](http://soft.vub.ac.be/Publications/2022/vub-tr-soft-22-17.pdf) shows that character-based merges can yield programs that are "no longer syntactically correct". This only happens when people edit the same spot at the same time, and the result is visible and fixable. [02-model-storage.md](02-model-storage.md) therefore keeps the model as code, with the timeline as a derived view.

3. **Executing code from documents.** Every collaborator's browser runs the model's code. Anyone with write access to a model can therefore run arbitrary JS in every viewer's session. This also applies to embedded viewers (use case 2). The code must run sandboxed, e.g. in a worker or sandboxed iframe with no access to the repo. The threat model and approach are in [05-sandboxing.md](05-sandboxing.md).

4. **Rebuild cost.** OCCT operations, especially booleans and fillets, are slow in wasm, and every change re-runs the timeline from the changed feature onward. This needs per-feature caching and a worker; replicad itself recommends a worker because "The model computation can take some time" ([use as a library](https://replicad.xyz/docs/use-as-a-library)). The multi-threaded build needs `SharedArrayBuffer`, i.e. a cross-origin-isolated page. According to a [Patchwork experiment](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/standalone-latex/src/compile.ts), "The current Patchwork host (sub.patchwork.inkandswitch.com) sets these". Standalone deployments must set COOP/COEP headers themselves.

5. **Kernel robustness and determinism.**
   - OCCT's fillets are a known weak spot. [Its own docs](https://occt3d.com/dev/doc/refman/html/class_b_rep_fillet_a_p_i___make_fillet.html): "there may be instances where the algorithm fails … There is no initial analysis of errors and they only become evident at the construction stage." The UI needs good per-feature error reporting.
   - Kernel upgrades may change results or topology for the same input (unverified). Documents should therefore record the kernel version they were built with.
   - Which operations are fragile, and how to report kernel failures to the user, is researched in [04-kernel-robustness.md](04-kernel-robustness.md).

6. **Licensing.** replicad is MIT. OCCT and its wasm builds are LGPL-2.1 with the [Open CASCADE exception](https://github.com/Open-Cascade-SAS/OCCT/blob/master/OCCT_LGPL_EXCEPTION.txt). As long as the wasm is an unmodified, separately loaded file (as in the openscad tool), users can swap it out, which is the intent of the LGPL. The exact obligations, e.g. license notices and source availability for the wasm, still need checking. This is not legal advice.

7. **Embedding.** We build all three variants (decal, reference in a sketch, annotation) and explore their UX in the broader Patchwork context. An example is deriving sketch geometry from an embedded SVG.
