# SailLab — PWA per sessioni di vela

Versione base funzionante, mobile-first, in italiano. I dati vengono salvati localmente in IndexedDB e non sono inviati a server esterni.

## File
- `index.html`: interfaccia e sezioni LIVE, SESSIONE, ANALISI, VENTO e DATI.
- `styles.css`: interfaccia scura responsive.
- `app.js`: GPS, registrazione, eventi, statistiche, archivio IndexedDB, CSV/JSON, importazione GPX.
- `manifest.webmanifest`: metadati PWA.
- `sw.js`: cache offline.
- `icons/icon.svg`: icona.

## Pubblicazione HTTPS con GitHub Pages
1. Crea un repository GitHub vuoto, ad esempio `saillab`.
2. Carica tutti i file e la cartella `icons/` nella root del repository.
3. Apri **Settings → Pages**.
4. In **Build and deployment**, scegli **Deploy from a branch**, branch `main`, folder `/ (root)`, poi salva.
5. Attendi la pubblicazione e apri l'URL HTTPS fornito da GitHub Pages.
6. Apri l'URL sul telefono e concedi il permesso di posizione. L'API GPS richiede HTTPS (localhost è un'eccezione per lo sviluppo).

## Installazione
- **iPhone:** apri il sito in Safari → Condividi → Aggiungi alla schermata Home. Consenti la posizione mentre usi il sito.
- **Android:** apri il sito in Chrome → menu ⋮ → Installa app / Aggiungi a schermata Home.
- Prima dell'uscita, apri l'app con connessione così che il service worker possa memorizzare i file per l'offline.

## Test locale
Non aprire `index.html` direttamente con `file://`, perché GPS, IndexedDB/service worker e installazione PWA possono avere limitazioni. Da una cartella con Python installato:
```bash
python3 -m http.server 8000
```
Apri `http://localhost:8000` sul computer per test UI. Per test GPS su telefono usa una distribuzione HTTPS.

## Funzioni implementate
- GPS con Geolocation API, velocità GPS convertita in nodi, rotta GPS, coordinate e accuratezza dichiarata dal sistema.
- Campionamento basato sugli aggiornamenti ricevuti dal browser; frequenza effettiva indicativa.
- Avvio, pausa, ripresa e termine sessione; salvataggio periodico e recupero delle sessioni salvate.
- Metadati: nome, barca, classe, equipaggio, luogo, vento stimato, setup e note.
- Eventi manuali con timestamp e ultima posizione nota.
- Statistiche di velocità (media, massimo, minimo, deviazione standard), distanza approssimata dalla sequenza di punti e grafico.
- Storico, apertura, esportazione JSON, eliminazione.
- Esportazione CSV dei campioni, backup JSON di tutte le sessioni.
- Importazione GPX di punti traccia/rotta con timestamp, coordinate e altitudine se presenti.
- Manifest, service worker e cache dei file principali.

## Non ancora implementato / limitazioni
- **Background:** iOS e Android possono sospendere o rallentare le pagine in background; una PWA web non può garantire la registrazione GPS continua a schermo spento. Per allenamenti critici, tenere l'app visibile e lo schermo acceso, oppure usare un'app nativa dedicata.
- **GPS:** velocità e rotta possono essere `null` quando il dispositivo non le fornisce; niente valori sintetici vengono creati. Gli aggiornamenti dipendono da hardware, condizioni e sistema operativo.
- **Sensori di movimento:** heel, pitch e accelerazioni non sono implementati. I permessi e le API variano; l'orientamento del telefono non rappresenta automaticamente quello della barca.
- **Heading bussola:** non implementato. La metrica disponibile è la rotta GPS sul fondo, non la prua.
- **Vento:** la schermata consente marcature manuali delle mure ma non calcola la direzione del vento. Una stima geometrica richiede segmenti di bolina identificati, correzioni e criteri espliciti.
- **Bordi:** le marcature delle mure sono basilari; segmentazione, confronto tra sessioni e metriche per bordo sono da sviluppare.
- **GPX:** i punti importati non hanno velocità o rotta calcolate, per non confondere i dati originali con misurazioni; timestamp mancanti restano null. L'analisi della traccia importata è limitata.
- **Sensori esterni/Bluetooth/celle di carico/cardio:** non collegati. Per integrarli servono protocollo reale del produttore, UUID BLE/SDK, formato e frequenza dei messaggi, unità e procedura di calibrazione. Web Bluetooth non è supportato da Safari iOS e non va dato per universale.
- **Confronto di sessioni, percentili configurabili, zoom sincronizzato e riconoscimento automatico manovre:** da sviluppare.
- **Resilienza:** il salvataggio periodico riduce il rischio ma non elimina la perdita dati in caso di arresto forzato o spazio insufficiente. Esportare backup regolari.

## Checklist prima dell'uso in acqua
1. Concedi posizione precisa e verifica che il badge GPS diventi attivo.
2. Prova all'aperto per almeno 5 minuti e confronta la velocità con uno strumento noto, senza assumere che siano identiche.
3. Blocca/sblocca il telefono e verifica se gli aggiornamenti continuano; ripeti con l'app in background.
4. Avvia, pausa, riprendi, registra virata/strambata e termina.
5. Ricarica la sessione dallo storico e verifica campioni, eventi e durata.
6. Esporta CSV e JSON e aprili su un computer.
7. Importa un GPX con e senza timestamp/altitudine e verifica che i campi assenti restino vuoti.
8. Testa l'offline dopo il primo caricamento; poi svuota la cache solo dopo aver fatto un backup.
9. Prova con guanti, sole diretto e telefono protetto dagli spruzzi. La PWA non è certificata per uso marino o impermeabilità.

## Note tecniche iOS Safari e Android Chrome
- Geolocation richiede HTTPS, consenso utente e può essere sospesa in background.
- I service worker supportano la cache offline, ma non mantengono un processo di acquisizione GPS in esecuzione.
- IndexedDB è disponibile nei browser moderni, ma i dati locali possono essere cancellati dal sistema o dall'utente.
- Web Bluetooth è disponibile solo in alcuni browser Chromium e non in Safari iOS; l'integrazione sensori va scelta in base al dispositivo reale.
- Le API di movimento/orientamento possono richiedere permessi espliciti e non forniscono automaticamente misure nautiche calibrate.
