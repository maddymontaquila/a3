FROM mcr.microsoft.com/dotnet/nightly/sdk:10.0 AS build
WORKDIR /src
COPY api-nyc.cs .
RUN dotnet publish api-nyc.cs -c Release -o /app/publish -p:PublishAot=false

FROM mcr.microsoft.com/dotnet/nightly/aspnet:10.0
RUN groupadd --system --gid 999 appuser && useradd --system --gid 999 --uid 999 --create-home appuser
WORKDIR /app
COPY --from=build /app/publish .
USER appuser
ENTRYPOINT ["dotnet", "api-nyc.dll"]
