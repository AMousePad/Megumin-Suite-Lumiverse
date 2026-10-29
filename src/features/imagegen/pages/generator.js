// ────────────────────────────────────────────────────────────────────────────
// Images tab — Generator page: where the images are drawn.
//
// Two ways on Lumiverse, picked at the top of the page:
//   ComfyUI                    the SillyTavern way: the suite talks to your
//                              ComfyUI (address, workflow, model, sampler,
//                              LoRAs). generatorComfy.js, unchanged from
//                              SillyTavern.
//   Lumiverse image connection one of the connections set up under Image
//                              Generation in Lumiverse. generatorLumi.js.
// ────────────────────────────────────────────────────────────────────────────

import { localProfile } from "../../../core/state.js";
import { saveProfileToMemory } from "../../../core/profile.js";
import { card, segmented } from "../../../ui/controls.js";
import { imageSource } from "../comfy.js";
import { renderComfyGenerator } from "./generatorComfy.js";
import { renderLumiGenerator } from "./generatorLumi.js";

export function renderGenerator(c, opts) {
    const s = localProfile.imageGen;
    const source = card("Draw with");
    source.append(segmented(
        [
            { id: "comfy", label: "ComfyUI" },
            { id: "lumi", label: "Lumiverse image connection" },
        ],
        imageSource(),
        (id) => {
            s.imageSource = id;
            saveProfileToMemory();
            if (opts && opts.onTested) opts.onTested();
            if (opts && opts.redraw) opts.redraw();
        },
    ));
    source.append(`<div class="igx-note" style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">${imageSource() === "comfy"
        ? "Your ComfyUI is reached from the Lumiverse server, so the address must work from that machine (127.0.0.1 means the server itself). Needs the CORS proxy permission."
        : "Uses a connection from Lumiverse's Image Generation settings; its model and sampler are set there."}</div>`);
    c.append(source);

    if (imageSource() === "comfy") renderComfyGenerator(c, opts);
    else renderLumiGenerator(c, opts);
}
