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