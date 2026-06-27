@echo off
robocopy "C:\Users\ulibe\OneDrive\AI\Wallbox-Backend" "C:\Users\ulibe\Wallbox-Backend" /E /XO /XF .env config.yml
echo.
echo Fertig - Dateien aus OneDrive uebernommen.
pause