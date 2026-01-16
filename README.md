Compile les images à détecter : https://hiukim.github.io/mind-ar-js-doc/tools/compile/

Le dossier "Images" sert uniquement à mettre les images à détecter (pour rappel, mais il ne sert pas pour le code).

Le dossier "animations", puis les dossiers suivants (target0 et target1), servent à mettre les séquences PNG. Les séquences PNG doivent être nommées : frame_000.png

Le dossier "audio", puis les dossiers suivants (target0 et target1), servent à mettre les sons. Les sons doivent être nommés : audio_000.mp3

Le dossier "models", puis les dossiers suivants (target0 et target1), servent à mettre les modèles 3D. Les modèles 3D doivent être nommés : model.glb

Le dossier "targets" contient le fichier qui compile les images à détecter. Le fichier doit être nommé : targets.mind

Les sous-dossiers target0 et target1 définissent l’image à détecter (la première ou la deuxième), car on peut détecter plusieurs images sur la même page. Ici, j’en ai mis deux, mais on peut en ajouter davantage (il faut alors modifier le code HTML en conséquence).
