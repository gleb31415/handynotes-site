# Правки во вендоренном KaTeX

KaTeX 0.16.47 лежит здесь как есть (`katex.mjs`, `katex.min.css`,
`fonts/*.woff2`), с одной точечной правкой. При обновлении KaTeX проверьте,
исправлено ли это выше по течению, и либо уберите правку, либо повторите её.

## 1. Высокие `\lfloor` / `\rfloor`: «MM» в SVG-пути

`katex.mjs`, функция `tallDelim`, ветки `case "lfloor"` и `case "rfloor"`.
Вторая половина пути начинается с `\nMM319 602 …` — две команды `M` подряд
без координат между ними. Браузер отвергает такой атрибут `d`
(`Error: <path> attribute d: Expected number, "…MM319 602…"`), пишет ошибку в
консоль и не рисует скобку пола вовсе. Исправлено на `\nM319 602 …` —
только в этих двух строках, остальные пути не тронуты.

Проверка: `scripts/handwriting-tests/mathlayout.e2e.mjs` больше не видит
«Known upstream KaTeX console errors (tall floor paths)».
