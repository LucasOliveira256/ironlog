# Catálogo de exercícios IRONLOG

`exercises.json`, schema 1, versão 2026.11.03.2. **1.447 exercícios**. 722 KB (89 KB com gzip), um exercício por linha.

## Estrutura

```
schema, version, count, about
normalize   → regra de normalização + lista de stopwords (fonte única para o app)
sources     → origem e licença dos dados
regions     → upper | lower | core | full
muscles     → 20 músculos {pt, en, region}
equipment   → 19 equipamentos {pt, en}
categories  → strength, powerlifting, olympic, strongman, plyometrics, cardio, stretching, mobility
exercises[] → ver abaixo
```

Cada exercício (uma linha):

| Campo | Significado |
|---|---|
| `id` | slug legível em inglês, **estável** (`barbell-bench-press`) |
| `pt` / `en` | nome de exibição |
| `region` | `upper`, `lower`, `core` ou `full` (calculada pelos músculos primários; cardio é sempre `full`) |
| `primary` / `secondary` | ids de `muscles`. Base para o mapa corporal |
| `equipment`, `category` | ids dos dicionários acima |
| `mechanic` | `compound` ou `isolation` |
| `force` | `push`, `pull` ou `static` |
| `uni` | só aparece quando é unilateral |
| `family` | agrupa variantes do mesmo movimento (só nos curados) |
| `parser` | apelidos já normalizados para casar texto de treino |

## Como o app deve casar um texto

1. Normalize: minúsculas, remova acentos (NFD), troque tudo fora de `a-z0-9` por espaço, **remova as `normalize.stopwords`**, junte com espaço simples.
2. Procure a chave em `parser`, no `pt` normalizado ou no `en` normalizado. `pt` e `en` **não se repetem** dentro de `parser`.
3. Cada chave pertence a **um único** exercício (validado). Se não achar, a Fase 3 usa fuzzy e pede confirmação.

A normalização em JavaScript foi testada contra a gerada em Python: todas as 13.449 chaves de busca são idempotentes e únicas por exercício.

## Regras de edição

- IDs que começam com `custom-` são **reservados** aos exercícios criados pelo usuário no app. Nunca use esse prefixo no catálogo.
- **Nunca renomeie nem reutilize um `id`.** O histórico vai apontar para ele. Para corrigir um nome, mude só `pt`/`en`.
- Para adicionar: copie uma linha, troque `id`, nomes e músculos. Um apelido novo deve estar normalizado e não pode existir em outro exercício.
- Rode `node validate.js` depois de editar à mão.
- Músculos devem ser ids de `muscles`; um mesmo músculo não pode ser primário e secundário.

## Regenerar

`catalog-build.zip` contém o gerador (famílias de movimento × equipamento × variação) e o mapa de classificação (`fe_map.txt`). Precisa do `dist/exercises.json` do free-exercise-db:

```
FEDB=fedb.json OUT=exercises.json python3 build.py
OUT=exercises.json node validate.js
OUT=exercises.json python3 lookup_test.py
```

A saída é determinística (duas execuções geram o arquivo idêntico).

## Origem e licença

- **free-exercise-db** (Unlicense, domínio público): fonte de ~208 exercícios e dos músculos desses itens.
- **Curadoria própria**: ~1.239 exercícios, nomes PT-BR e apelidos de academia.
- MuscleWiki e OpenGym **não** foram copiados: são conteúdo proprietário.

## Limites conhecidos

- 1.447, não 1.500. O crescimento é por versões.
- Os ~208 itens da free-exercise-db herdam o mapeamento de músculos e equipamento da fonte (convertido por regra), e o deltoide é inferido pelo nome. Podem precisar de ajuste.
- Os nomes PT-BR e os apelidos são escolhas minhas: revise os que você usa no dia a dia.
- Variantes com a mesma estrutura (barra, halter, polia) têm músculos idênticos. Não há distinção de ênfase fina.
