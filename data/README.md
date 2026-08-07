Put `Southern_Oregon_Housing_Matrix_REVERIFIED.csv` here.

The loader (`scripts/load_data.py`) and the CI workflow both expect this
file at `data/Southern_Oregon_Housing_Matrix_REVERIFIED.csv` by default —
adjust the path argument if yours lives elsewhere.

Two-row header: the loader reads `rows[1]` as the actual column header row
(matching the original script), so keep that shape if you re-export the CSV.
