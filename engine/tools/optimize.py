"""Optimize tools (docs/02_FEATURES.md §B). Phase 1: Compress (B1).

AGPL-free by decision (docs/09 §3): pikepdf + Pillow instead of Ghostscript.

What Compress does:
- finds how large each image is drawn (utils/placement.py) and downsamples it to the level's
  DPI, then re-encodes it as JPEG at the level's quality (optionally in grayscale);
- leaves alone what would be damaged or not shrink: line art / screenshots with few colours,
  CMYK and special colour spaces, stencil masks, 1-bit / JBIG2 / CCITT images, images with a
  /Decode array; an image is only replaced if the new data is clearly smaller;
- optionally strips document metadata, removes unused resources and objects, recompresses
  streams and packs objects into object streams;
- if the result is not smaller than the original, keeps the original and creates no file.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

import pikepdf
from pikepdf import Name, ObjectStreamMode, PdfImage
from PIL import Image

from jobs import JobContext, ToolResult
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.placement import image_display_sizes
from utils.validation import (
    option_bool,
    option_choice,
    option_int,
    options_dict,
    passwords_map,
)


@dataclass(frozen=True)
class Level:
    dpi: int
    quality: int


LEVELS = {
    "extreme": Level(72, 40),
    "recommended": Level(150, 60),
    "low": Level(300, 80),
}
DOWNSAMPLE_SLACK = 1.15  # only downsample when the image has >15% more pixels than needed
MIN_GAIN = 0.9  # replace an image only if the new data is at most 90% of the old
FEW_COLOURS = 256  # images with this few colours are line art / screenshots: keep lossless
SKIP_FILTERS = {"/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode"}
SUPPORTED_SPACES = {"/DeviceRGB", "/DeviceGray"}


def _filters(obj: pikepdf.Stream) -> list[str]:
    value = obj.get("/Filter")
    if isinstance(value, pikepdf.Array):
        return [str(v) for v in value]
    return [str(value)] if value is not None else []


def _colour_space(obj: pikepdf.Stream) -> str | None:
    """'/DeviceRGB' or '/DeviceGray' (ICC-based with 3 or 1 components counts), else None."""
    space = obj.get("/ColorSpace")
    if isinstance(space, Name):
        name = str(space)
        return name if name in SUPPORTED_SPACES else None
    if isinstance(space, pikepdf.Array) and len(space) == 2 and space[0] == Name.ICCBased:
        n = space[1].get("/N")
        return {3: "/DeviceRGB", 1: "/DeviceGray"}.get(int(n) if n is not None else 0)
    return None


def _few_colours(img: Image.Image) -> bool:
    sample = img.convert("RGB")
    sample.thumbnail((128, 128))
    return sample.getcolors(FEW_COLOURS) is not None


def _recompress(
    obj: pikepdf.Stream, drawn: tuple[float, float], level: Level, grayscale: bool
) -> bool:
    """Downsample/re-encode one image in place. Returns True if it was replaced."""
    if obj.get("/ImageMask") or "/Decode" in obj or "/Mask" in obj:
        return False
    if int(obj.get("/BitsPerComponent", 8)) != 8:
        return False
    filters = _filters(obj)
    if SKIP_FILTERS.intersection(filters):
        return False
    space = _colour_space(obj)
    if space is None:
        return False
    try:
        img = PdfImage(obj).as_pil_image()
    except Exception:  # unsupported encoding: leave it as it is
        return False

    target_w = max(1, round(drawn[0] / 72 * level.dpi))
    target_h = max(1, round(drawn[1] / 72 * level.dpi))
    width, height = img.size
    downsample = width * height > target_w * target_h * DOWNSAMPLE_SLACK**2
    is_jpeg = filters == ["/DCTDecode"]
    if not downsample and not grayscale and is_jpeg:
        return False  # already JPEG at a sensible resolution: re-encoding would only lose
    if not is_jpeg and _few_colours(img):
        return False  # line art / screenshot: JPEG would add artefacts

    if downsample:
        # The larger ratio keeps *both* axes at or above the target DPI (images are often drawn
        # slightly stretched, so the two axes need different scale factors).
        ratio = max(target_w / width, target_h / height)
        img = img.resize(
            (max(1, round(width * ratio)), max(1, round(height * ratio))), Image.Resampling.LANCZOS
        )
    gray = grayscale or space == "/DeviceGray"
    img = img.convert("L" if gray else "RGB")
    buffer = io.BytesIO()
    img.save(buffer, "JPEG", quality=level.quality, optimize=True)
    data = buffer.getvalue()
    if len(data) > len(obj.read_raw_bytes()) * MIN_GAIN:
        return False

    obj.write(data, filter=Name.DCTDecode)
    obj.Width, obj.Height = img.size
    obj.ColorSpace = Name.DeviceGray if gray else Name.DeviceRGB
    obj.BitsPerComponent = 8
    for key in ("/DecodeParms", "/Interpolate"):
        if key in obj:
            del obj[key]
    return True


def compress(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    level_name = option_choice(options, "level", (*LEVELS, "custom"), "recommended")
    if level_name == "custom":
        level = Level(
            option_int(options, "dpi", 150, lo=36, hi=600),
            option_int(options, "quality", 60, lo=10, hi=95),
        )
        grayscale = option_bool(options, "grayscale", False)
        strip_metadata = option_bool(options, "remove_metadata", False)
    else:
        level = LEVELS[level_name]
        grayscale = False
        strip_metadata = False

    original_bytes = source.stat().st_size
    tmp = ctx.temp_dir / "compressed.pdf"
    with open_pdf(source, passwords_map(params)) as pdf:
        ctx.progress(2, "Measuring images")
        drawn = image_display_sizes(pdf)
        images = [
            obj
            for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == Name.Image
        ]
        replaced = 0
        for n, obj in enumerate(images):
            ctx.check_cancelled()
            ctx.progress(5 + n * 75 / max(len(images), 1), f"Image {n + 1} of {len(images)}")
            size = drawn.get(obj.objgen)
            if size is None:
                continue  # not drawn anywhere: dropped below if unreferenced
            if _recompress(obj, size, level, grayscale):
                replaced += 1

        if strip_metadata:
            for key in list(pdf.docinfo.keys()):
                del pdf.docinfo[key]
            if "/Metadata" in pdf.Root:
                del pdf.Root["/Metadata"]
        ctx.progress(80, "Removing unused objects")
        pdf.remove_unreferenced_resources()
        save_pdf(
            pdf,
            tmp,
            ctx,
            start=82,
            message="Saving",
            keep_encryption=True,
            compress_streams=True,
            recompress_flate=True,
            object_stream_mode=ObjectStreamMode.generate,
        )

    new_bytes = tmp.stat().st_size
    stats: dict[str, Any] = {
        "original_bytes": original_bytes,
        "images": len(images),
        "images_recompressed": replaced,
        "level": level_name,
    }
    if new_bytes >= original_bytes:
        # docs/02 B1: never hand back a bigger file — keep the original and say so.
        tmp.unlink(missing_ok=True)
        return ToolResult([], {**stats, "bytes": original_bytes, "kept_original": True})
    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "compressed", protected=[source])
    saved = round((1 - new_bytes / original_bytes) * 100, 1)
    return ToolResult([final], {**stats, "bytes": new_bytes, "saved_percent": saved})
