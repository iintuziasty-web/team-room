# Team Room Community для iOS

Основной вариант для iPhone — открыть **свой HTTPS-хаб** в Safari и добавить его на экран «Домой». Нативная версия — дополнительный вариант для тех, кто самостоятельно собирает приложения в Xcode.

## Сборка

Нужен Mac с полным Xcode и установленной платформой iOS. Из корня репозитория (или распакованного архива исходников):

```sh
TEAMROOM_HUB_URL=https://your-hub.example node ios-app/build.mjs --simulator
```

Скрипт создаёт иконки и отдельный `Info.configured.plist` с вашим адресом. Не запускайте исходный Xcode-проект с оставленным `__HUB_URL__`: сначала задайте свой URL через сборщик либо измените `TeamRoomHubURL` в настройках проекта вручную.

Для собственного iPhone с настроенной подписью Apple:

```sh
TEAMROOM_HUB_URL=https://your-hub.example TEAMROOM_APPLE_TEAM=YOUR_TEAM_ID node ios-app/build.mjs --signed
```

`YOUR_TEAM_ID` — ваш десятисимвольный Team ID Apple. Apple ID и сертификаты настраиваются локально в Xcode. Приложение использует только указанный вами хаб; адрес сервера и ключи автора в исходники не входят.

Архив `.xcarchive` нужно экспортировать с подходящей подписью через Xcode. Созданный скриптом ZIP содержит **исходники**, а не готовую установку на любой iPhone. Для App Store / TestFlight потребуется собственный процесс публикации и учётная запись Apple Developer.

При открытии `ios-app/TeamRoom.xcodeproj` после сборки задайте `INFOPLIST_FILE` на `.build-cache/Info.configured.plist`, чтобы Xcode использовал подготовленный адрес, либо укажите его в исходном Info.plist. Не публикуйте артефакты с настройками своего приватного хаба как общую загрузку.
