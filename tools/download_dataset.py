import os
from huggingface_hub import HfApi, hf_hub_download

repo_id = "facebook/action100m-preview"
api = HfApi()

# Usiamo la directory corrente: HF creerà automaticamente la cartella "data"
local_dir = "." 
cartella_locale_effettiva = "./data"

print("🔍 Recupero informazioni dal repository remoto...")

# Ottieni la lista dei file remoti e filtrali
files = api.list_repo_files(repo_id, repo_type="dataset")
data_files = [f for f in files if f.startswith("data/")]

# 1. Calcola i file disponibili
totale_remoti = len(data_files)

# 2. Calcola i file già scaricati
totale_locali = 0
if os.path.exists(cartella_locale_effettiva):
    # Conta solo i file reali presenti nella cartella (ignorando eventuali sottocartelle)
    totale_locali = len([f for f in os.listdir(cartella_locale_effettiva) if os.path.isfile(os.path.join(cartella_locale_effettiva, f))])

# Stampa un riepilogo pulito
print("\n" + "-" * 40)
print("📊 STATISTICHE DATASET")
print(f"File totali su Hugging Face (in 'data/'): {totale_remoti}")
print(f"File già presenti sul server locale:    {totale_locali}")
print(f"File rimanenti da scaricare:            {totale_remoti - totale_locali}")
print("-" * 40 + "\n")

# Seleziona i primi 5 file
files_to_download = data_files[:50]
print(f"Avvio il download o la verifica dei {len(files_to_download)} file di prova...")

# Scarica i file
for file in files_to_download:
    print(f"Elaborazione: {file}")
    hf_hub_download(
        repo_id=repo_id,
        filename=file,
        repo_type="dataset",
        local_dir=local_dir, 
        local_dir_use_symlinks=False
    )

print("\n✅ Operazione completata!")