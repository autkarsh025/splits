# Oval

**How fast is your time, really?** Live at [utkarshagarwal.dev/splits](https://utkarshagarwal.dev/oval/).

Put in one or more race PRs, from 800 m to the marathon, and Oval shows:

- **Where you stand** against 3.49 million real marathon finishes (11 races, 2000 to 2023), by sex and age group, and your place in every one of those fields
- **College runners**: your percentile among college club runners' PRs in the same event (track, cross country and road)
- **High school benchmarks**: the 2025 CIF State Cross Country champions' times
- **A ghost race**: you against the world record and the top 1%, top 10% and median marathoners, animated on a 400 m track
- **Your PR profile**: which PR is really your best, and whether you lean toward speed or endurance
- **Six pages** (Your times, Rankings, Ghost race, Race plan, Training, The data) under tabs at the top
- **Race plan builder**: pick a race, course, forecast and how bold to be. Oval sets a goal from your races (leaning on the one closest in distance), then writes the plan: how to run each phase, checkpoint splits with an on-track window, warmup, gels and drinks. Prints on one page with a pace band
- **Equivalent times** at every distance (VDOT and Riegel), **training paces**, a **goal finder** and a **pace converter**

Everything recomputes as you type, and the URL holds your inputs so a result can be shared.

## How it works

| Part | What it does |
|---|---|
| `web/model.js` | The running model: Daniels and Gilbert VDOT (oxygen cost of a pace divided by the share of VO2max sustainable for that duration), its inverse for equivalent times and training paces, Riegel's formula, percentiles from quantile tables, split plans |
| `data/build_data.py` | Downloads the open datasets in GitHub Actions and reduces millions of results to a 60 KB file of quantile tables (`data/races.json`) |
| `web/app.js` | The page: inputs, rankings, the ghost race (canvas), charts (SVG) |
| `web/plan.js` | The race plan: goal time with adjustments for distance beyond your longest race, course, heat and boldness; checkpoints; phases; race-morning notes |
| `test/` | Checks the model against Daniels' published tables, percentile math, split plans, and that the data is sane |

Workflows: `data` rebuilds the distributions monthly; `site` runs the tests, builds the page and publishes it on every push.

## Data

All three datasets are published under CC BY 4.0:

- Marathon Data 2000–2019, Colorado School of Mines (Zenodo 10.5281/zenodo.6959864): Chicago, California International, Honolulu, Houston, Philadelphia, Marine Corps, Twin Cities, New York, Los Angeles, Grandma's
- London Marathon Data 2018–2023, University College Cork (Zenodo 10.5281/zenodo.10960982)
- National Running Club Database v2.0.0 (Zenodo 10.5281/zenodo.20578527): college club cross country, track and road results; each athlete's best time per event is used

High school benchmarks are the official winning times from the CIF's 2025 State Cross Country Championships recap. World records are as ratified by World Athletics (checked November 2026).

## Limits

Marathon fields are self-selected, so beating 60% of them means more than beating 60% of the population. Equivalent times assume you trained for the distance. The heat adjustment is a coaching rule of thumb, not a physiological model.

## Run it

```
npm test            # model tests (Node 22)
python3 build.py    # assemble public/
python3 -m http.server -d public
```
