"""Generate deterministic, authored illustrations for synthetic vision evaluation.

Requires Pillow. No model calls, downloads, source photos, or random inputs.
Run this file from any directory to regenerate the adjacent PNG fixtures.
"""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent
SIZE = 512
SCALE = 2


class Canvas:
    def __init__(self):
        self.image = Image.new("RGB", (SIZE * SCALE, SIZE * SCALE), "#b9e6f1")
        self.draw = ImageDraw.Draw(self.image)

    def shape(self, kind, bounds, fill, outline=None, width=3):
        scaled = tuple(round(coordinate * SCALE) for coordinate in bounds)
        getattr(self.draw, kind)(scaled, fill=fill, outline=outline, width=width * SCALE)

    def polygon(self, points, fill, outline=None, width=3):
        self.draw.polygon(
            [(round(x * SCALE), round(y * SCALE)) for x, y in points],
            fill=fill,
            outline=outline,
            width=width * SCALE,
        )

    def line(self, points, fill, width=3):
        self.draw.line(
            [(round(x * SCALE), round(y * SCALE)) for x, y in points],
            fill=fill,
            width=width * SCALE,
            joint="curve",
        )

    def background(self):
        self.shape("ellipse", (397, 27, 464, 94), "#ffe7a1")
        self.shape("ellipse", (-100, 216, 343, 483), "#8cbc70")
        self.shape("ellipse", (207, 228, 612, 474), "#77ad64")
        self.shape("rectangle", (0, 332, 512, 512), "#67a852")
        self.shape("rectangle", (40, 172, 53, 338), "#967455")
        self.shape("ellipse", (5, 102, 89, 243), "#43835a")
        self.shape("rectangle", (466, 180, 478, 337), "#967455")
        self.shape("ellipse", (429, 113, 514, 251), "#43835a")
        for x, y in ((39, 405), (107, 470), (423, 417), (469, 480), (338, 480)):
            self.line(((x - 8, y + 9), (x, y - 9), (x + 4, y + 9)), "#497f39", 3)

    def save(self, name):
        # Explicit RGB PNG with no metadata or text chunks.
        self.image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(
            ROOT / name, format="PNG", optimize=True
        )


def dog():
    c = Canvas()
    c.background()
    edge = "#5c3824"
    c.shape("ellipse", (126, 422, 393, 466), "#527f40")
    # Raised brown tail, broad sitting haunches, and a white chest.
    c.line(((340, 391), (382, 358), (397, 314), (387, 283)), edge, 29)
    c.line(((340, 391), (382, 358), (397, 314), (387, 283)), "#a76a36", 23)
    c.shape("ellipse", (159, 246, 353, 439), "#aa713f", edge)
    c.shape("ellipse", (139, 349, 220, 445), "#a26836", edge)
    c.shape("ellipse", (296, 349, 374, 445), "#a26836", edge)
    c.shape("ellipse", (207, 252, 307, 396), "#f3e9d5")
    c.shape("rounded_rectangle", (192, 337, 233, 446), "#b37c48", edge)
    c.shape("rounded_rectangle", (279, 337, 320, 446), "#b37c48", edge)
    c.shape("ellipse", (183, 422, 243, 452), "#f3e9d5", edge)
    c.shape("ellipse", (269, 422, 329, 452), "#f3e9d5", edge)
    # Floppy ears, rounded dog head, projecting pale muzzle, black nose.
    c.shape("ellipse", (132, 132, 217, 273), "#81502c", edge)
    c.shape("ellipse", (299, 132, 384, 273), "#81502c", edge)
    c.shape("ellipse", (172, 115, 341, 292), "#b98049", edge)
    c.polygon(((248, 126), (269, 126), (281, 232), (235, 232)), "#f3e9d5")
    c.shape("ellipse", (204, 179, 220, 198), "#251d18")
    c.shape("ellipse", (293, 179, 309, 198), "#251d18")
    c.shape("ellipse", (208, 180, 213, 185), "#ffffff", width=1)
    c.shape("ellipse", (297, 180, 302, 185), "#ffffff", width=1)
    c.shape("ellipse", (208, 205, 305, 276), "#f3e9d5", edge)
    c.shape("ellipse", (228, 235, 285, 278), "#41251f")
    c.shape("ellipse", (245, 253, 270, 286), "#da8b91", edge, 2)
    c.shape("ellipse", (237, 211, 278, 239), "#251d18")
    c.line(((257, 235), (257, 248)), edge, 3)
    c.save("dog.png")


def person():
    c = Canvas()
    c.background()
    edge = "#3a4552"
    # Adult proportions, blue sweater, hands, trousers, and shoes.
    c.shape("ellipse", (137, 458, 382, 485), "#527f40")
    c.polygon(((199, 316), (308, 316), (322, 458), (269, 461),
               (254, 365), (239, 461), (187, 458)), "#344b65", edge)
    c.shape("ellipse", (172, 447, 241, 476), "#333a43", edge)
    c.shape("ellipse", (268, 447, 340, 476), "#333a43", edge)
    c.polygon(((200, 199), (230, 182), (282, 182), (313, 199),
               (350, 302), (316, 316), (294, 248), (314, 334),
               (193, 334), (207, 248), (185, 316), (151, 302)), "#2879c4", edge)
    c.shape("ellipse", (148, 298, 184, 344), "#dca07b", edge, 2)
    c.shape("ellipse", (317, 298, 353, 344), "#dca07b", edge, 2)
    c.line(((196, 326), (311, 326)), "#1c5d9c", 5)
    c.shape("rounded_rectangle", (234, 162, 278, 205), "#dca07b", edge, 2)
    c.line(((223, 190), (235, 204), (256, 211), (278, 204), (291, 190)), "#174e8b", 5)
    c.shape("ellipse", (194, 90, 218, 139), "#dca07b", edge, 2)
    c.shape("ellipse", (294, 90, 318, 139), "#dca07b", edge, 2)
    c.shape("ellipse", (205, 52, 307, 182), "#e3ab85", edge, 2)
    c.polygon(((207, 110), (201, 78), (208, 49), (232, 33),
               (265, 32), (293, 47), (308, 69), (307, 110),
               (290, 88), (280, 63), (240, 73), (221, 68)), "#543d31")
    c.line(((220, 105), (238, 102)), "#543d31", 4)
    c.line(((274, 102), (291, 106)), "#543d31", 4)
    c.shape("ellipse", (225, 111, 233, 120), "#332b26")
    c.shape("ellipse", (277, 111, 285, 120), "#332b26")
    c.line(((254, 116), (249, 136), (258, 138)), "#b57960", 3)
    c.line(((236, 151), (248, 159), (265, 159), (277, 151)), "#7f4e3c", 3)
    c.save("person.png")


def cat():
    c = Canvas()
    c.background()
    edge = "#82452b"
    c.shape("ellipse", (136, 427, 384, 463), "#527f40")
    # A curved orange tail, narrow body, paws, and upright triangular ears.
    c.line(((325, 411), (381, 408), (400, 382), (400, 330), (382, 306)), edge, 29)
    c.line(((325, 411), (381, 408), (400, 382), (400, 330), (382, 306)), "#e29443", 23)
    c.shape("ellipse", (172, 252, 342, 440), "#de8b39", edge)
    c.shape("ellipse", (225, 274, 291, 426), "#f6dcb2")
    c.shape("rounded_rectangle", (203, 343, 242, 447), "#e9a552", edge)
    c.shape("rounded_rectangle", (275, 343, 314, 447), "#e9a552", edge)
    c.shape("ellipse", (190, 426, 248, 453), "#f6dcb2", edge)
    c.shape("ellipse", (269, 426, 327, 453), "#f6dcb2", edge)
    c.polygon(((168, 183), (167, 97), (224, 147)), "#e9a552", edge)
    c.polygon(((287, 147), (347, 97), (345, 183)), "#e9a552", edge)
    c.polygon(((180, 157), (178, 117), (208, 145)), "#cf8e83")
    c.polygon(((305, 145), (335, 117), (334, 157)), "#cf8e83")
    c.shape("ellipse", (162, 137, 353, 296), "#e9a552", edge)
    for points in (((227, 144), (238, 172)), ((256, 140), (257, 174)),
                   ((286, 144), (278, 172))):
        c.line(points, "#b6662d", 7)
    c.shape("ellipse", (192, 194, 235, 220), "#b6bd64", edge, 2)
    c.shape("ellipse", (278, 194, 321, 220), "#b6bd64", edge, 2)
    c.shape("ellipse", (210, 195, 217, 219), "#24251d")
    c.shape("ellipse", (296, 195, 303, 219), "#24251d")
    c.shape("ellipse", (217, 228, 263, 270), "#f6dcb2")
    c.shape("ellipse", (253, 228, 299, 270), "#f6dcb2")
    c.polygon(((243, 232), (271, 232), (257, 246)), "#a55e60", edge, 2)
    c.line(((257, 245), (257, 257), (248, 262)), edge, 2)
    c.line(((257, 257), (266, 262)), edge, 2)
    for start, finish in (((221, 240), (137, 228)), ((221, 251), (134, 255)),
                          ((224, 261), (144, 280)), ((293, 240), (377, 228)),
                          ((293, 251), (380, 255)), ((290, 261), (370, 280))):
        c.line((start, finish), "#68503d", 2)
    c.line(((177, 331), (204, 340)), "#b6662d", 7)
    c.line(((174, 360), (200, 367)), "#b6662d", 7)
    c.line(((313, 340), (337, 331)), "#b6662d", 7)
    c.line(((316, 367), (341, 359)), "#b6662d", 7)
    c.save("cat.png")


if __name__ == "__main__":
    dog()
    person()
    cat()
